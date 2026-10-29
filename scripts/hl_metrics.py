"""Calcula, a partir da API pública da Hyperliquid, as métricas que a Hyperdash usa no copy score.

Retornos diários = (PnL realizado - taxas + funding + variação do não realizado) / valor da conta
do dia anterior. O não realizado é marcado pelo fechamento diário (candles 1d) de cada moeda.
Assim depósitos e saques não contam como lucro.

Uso: python3 hl_metrics.py 0xENDERECO [0xOUTRO ...]   (imprime JSON por carteira)
"""
import json
import math
import sys
import time
from collections import defaultdict

import requests

URL = "https://api.hyperliquid.xyz/info"
DAY = 86_400_000
LOOKBACK_DAYS = 400


def info(body, attempts=5):
    for i in range(attempts):
        r = requests.post(URL, json=body, timeout=30)
        if r.status_code == 429 and i < attempts - 1:
            time.sleep(3 * 2 ** i)
            continue
        r.raise_for_status()
        return r.json()


def paged(kind, user, start, key_time, page_size):
    out, seen = [], set()
    while True:
        batch = info({"type": kind, "user": user, "startTime": start, "aggregateByTime": False}
                     if kind == "userFillsByTime" else {"type": kind, "user": user, "startTime": start})
        new = [b for b in batch if json.dumps(b, sort_keys=True) not in seen]
        for b in new:
            seen.add(json.dumps(b, sort_keys=True))
        out += new
        if len(batch) < page_size or not new:
            return out
        start = max(key_time(b) for b in batch)


def daily_closes(coin, start, end, cache={}):
    if coin not in cache:
        try:
            c = info({"type": "candleSnapshot", "req": {"coin": coin, "interval": "1d",
                                                         "startTime": start, "endTime": end}})
            cache[coin] = {k["t"] // DAY: float(k["c"]) for k in c}
        except requests.HTTPError:
            cache[coin] = {}
    return cache[coin]


def round_trips(fills):
    """Agrupa fills em operações: abre quando a posição sai de zero e fecha quando volta (ou inverte)."""
    trips, open_ = [], {}
    for f in fills:
        if f["coin"].startswith("@") or f["dir"] in ("Buy", "Sell", "Spot Dust Conversion"):
            continue  # spot
        coin, start, sz = f["coin"], float(f["startPosition"]), float(f["sz"])
        end = start + (sz if f["side"] == "B" else -sz)
        t = open_.get(coin)
        if t is None:
            t = open_[coin] = {"coin": coin, "open": f["time"], "pnl": 0.0, "fills": 0}
        t["pnl"] += float(f["closedPnl"]) - float(f["fee"])
        t["fills"] += 1
        if abs(end) < 1e-12 or start * end < 0:
            t["close"] = f["time"]
            trips.append(t)
            del open_[coin]
            if start * end < 0:  # inverteu: nova operação começa no mesmo fill
                open_[coin] = {"coin": coin, "open": f["time"], "pnl": 0.0, "fills": 0}
    return trips, list(open_.values())


def daily_returns(fills, funding, portfolio, now):
    first_day = (now - LOOKBACK_DAYS * DAY) // DAY
    last_day = now // DAY
    pnl = defaultdict(float)
    for f in fills:
        if f["coin"].startswith("@"):
            continue
        pnl[f["time"] // DAY] += float(f["closedPnl"]) - float(f["fee"])
    for x in funding:
        pnl[x["time"] // DAY] += float(x["delta"]["usdc"])

    # Não realizado: reconstrói a posição por moeda ao fim de cada dia e marca no fechamento.
    pos_by_day = defaultdict(dict)  # dia -> {coin: (szi, preço médio)}
    state = {}
    fills_by_day = defaultdict(list)
    for f in fills:
        if not f["coin"].startswith("@"):
            fills_by_day[f["time"] // DAY].append(f)
    upnl_prev = 0.0
    upnl = {}
    for d in range(first_day, last_day + 1):
        for f in fills_by_day.get(d, []):
            sz = float(f["sz"]) * (1 if f["side"] == "B" else -1)
            szi, entry = state.get(f["coin"], (float(f["startPosition"]), float(f["px"])))
            szi = float(f["startPosition"])
            new = szi + sz
            px = float(f["px"])
            if abs(new) < 1e-12:
                state.pop(f["coin"], None)
                continue
            if szi == 0 or szi * new < 0:
                entry = px
            elif abs(new) > abs(szi):
                entry = (entry * abs(szi) + px * abs(sz)) / abs(new)
            state[f["coin"]] = (new, entry)
        u = 0.0
        for coin, (szi, entry) in state.items():
            closes = daily_closes(coin, (first_day - 1) * DAY, now)
            mark = closes.get(d) or closes.get(d - 1) or entry
            u += szi * (mark - entry)
        upnl[d] = u
    # Variação do não realizado também precisa descontar o que virou realizado; como o realizado
    # do fill já é relativo ao preço médio, PnL total do dia = realizado + Δ(não realizado).
    av = sorted((int(t), float(v)) for t, v in portfolio["allTime"]["accountValueHistory"])
    rets, days, equity = [], [], []
    prev_u = None
    for d in range(first_day, last_day + 1):
        e = interp(av, d * DAY)
        u = upnl[d]
        if prev_u is not None and e and e > 0:
            r = (pnl.get(d, 0.0) + u - prev_u) / e
            if e > 0 and (days or abs(r) > 0 or pnl.get(d)):
                rets.append(max(r, -1.0))
                days.append(d)
                equity.append(e)
        prev_u = u
    return days, rets, equity


def interp(series, t):
    if not series or t < series[0][0]:
        return None
    for (t0, v0), (t1, v1) in zip(series, series[1:]):
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * (t - t0) / (t1 - t0) if t1 > t0 else v1
    return series[-1][1]


def risk_stats(rets):
    n = len(rets)
    if n < 5:
        return {"sharpe": None, "sortino": None, "drawdown": None}
    mean = sum(rets) / n
    sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (n - 1))
    # Desvio padrão só dos dias negativos: bate com a Hyperdash (5,2 vs 5,5 na 0x01bb), o
    # semidesvio clássico sobre todos os dias dava 7,1.
    neg = [r for r in rets if r < 0]
    nm = sum(neg) / len(neg) if neg else 0
    down = math.sqrt(sum((r - nm) ** 2 for r in neg) / (len(neg) - 1)) if len(neg) > 1 else 0
    idx, peak, mdd = 1.0, 1.0, 0.0
    for r in rets:
        idx *= 1 + r
        peak = max(peak, idx)
        mdd = max(mdd, 1 - idx / peak)
    k = math.sqrt(365)
    return {"sharpe": mean / sd * k if sd else None,
            "sortino": mean / down * k if down else None,
            "drawdown": mdd * 100}


def style(trips, days_active):
    if not trips:
        return None
    hold = sorted((t["close"] - t["open"]) / 3_600_000 for t in trips)
    med = hold[len(hold) // 2]
    per_day = len(trips) / max(days_active, 1)
    if per_day > 50:
        return "algo"
    if med < 1:
        return "scalp"
    if med < 24:
        return "intraday"
    if med < 24 * 14:
        return "swing"
    return "position"


def metrics(user, now=None):
    now = now or int(time.time() * 1000)
    start = now - LOOKBACK_DAYS * DAY
    # Fills desde o início (a API guarda os 10 mil mais recentes) para winrate e contagem de operações.
    fills = sorted(paged("userFillsByTime", user, 0, lambda f: f["time"], 2000), key=lambda f: f["time"])
    funding = paged("userFunding", user, start, lambda f: f["time"], 500)
    portfolio = dict(info({"type": "portfolio", "user": user}))
    days, rets, _ = daily_returns(fills, funding, portfolio, now)
    trips, _ = round_trips(fills)

    out = {"address": user, "fills": len(fills), "fillsTruncated": len(fills) >= 10_000}
    for w in (7, 30, 90, 180, 365):
        cut = now // DAY - w
        r = [x for d, x in zip(days, rets) if d > cut]
        s = risk_stats(r)
        out.update({f"sharpe{w}d": s["sharpe"], f"sortino{w}d": s["sortino"], f"drawdown{w}d": s["drawdown"]})
        tw = [t for t in trips if t["close"] > now - w * DAY]
        out[f"trades{w}d"] = len(tw)
        out[f"winrate{w}d"] = 100 * sum(t["pnl"] > 0 for t in tw) / len(tw) if tw else None
    out["totalTrades"] = len(trips)
    out["winrate"] = 100 * sum(t["pnl"] > 0 for t in trips) / len(trips) if trips else None
    first = fills[0]["time"] if fills else now
    out["tag"] = style(trips, (now - first) / DAY)
    out["perpsEquity"] = float(info({"type": "clearinghouseState", "user": user})["marginSummary"]["accountValue"])
    # Valor total (perps + spot + vaults), que é o que a Hyperdash mostra como equity.
    av = portfolio["allTime"]["accountValueHistory"]
    out["equity"] = float(av[-1][1]) if av else out["perpsEquity"]
    out["lastTradeAt"] = fills[-1]["time"] if fills else None
    out["pnlAllTime"] = float(portfolio["allTime"]["pnlHistory"][-1][1]) if portfolio["allTime"]["pnlHistory"] else 0
    out["volume"] = sum(float(f["px"]) * float(f["sz"]) for f in fills)
    return out


if __name__ == "__main__":
    for a in sys.argv[1:]:
        print(json.dumps(metrics(a.lower()), indent=1))
