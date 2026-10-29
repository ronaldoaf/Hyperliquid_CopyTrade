"""Estima o copy score (V1 e V2) da Hyperdash para qualquer carteira.

Calcula as métricas pela API da Hyperliquid (hl_metrics.py) e aplica o modelo treinado
nas ~2000 carteiras da Hyperdash (HistGradientBoosting, mesmo critério de copyscore_model.py).
Só usa como features as colunas que hl_metrics.py também calcula.

Uso: python3 score_wallet.py hyperdash_traders.json 0xENDERECO [...]
"""
import json
import sys

import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from hl_metrics import metrics

TAGS = ["algo", "scalp", "swing", "position", "intraday"]
FEATS = [f"{m}{w}d" for m in ("sharpe", "sortino", "drawdown") for w in (30, 90, 180, 365)] + \
        [f"winrate{w}d" for w in (30, 90, 180, 365)] + ["trades30d", "perpsEquity", "totalTrades", "lastTradeAt"]


def frame(rows):
    d = pd.DataFrame(rows)
    X = d.reindex(columns=FEATS).apply(pd.to_numeric, errors="coerce")
    X["lastTradeAt"] = X["lastTradeAt"] // 1000
    for t in TAGS:
        X["t_" + t] = (d.get("tag") == t) * 1
    return X.fillna(-999)


def train(path):
    d = pd.DataFrame(json.load(open(path)))
    X = frame(d.to_dict("records"))
    models = {}
    for y, mask in [("copyScore", pd.to_numeric(d.copyScore) > 0), ("copyScoreV2", d.copyScoreV2.notna())]:
        models[y] = HistGradientBoostingRegressor(max_iter=300, random_state=0).fit(X[mask], d.loc[mask, y].astype(float))
    return models


def score(models, m):
    m = dict(m, perpsEquity=m["equity"])  # a Hyperdash chama de perpsEquity o valor total da conta
    X = frame([m])
    v1 = float(models["copyScore"].predict(X)[0])
    v2 = float(models["copyScoreV2"].predict(X)[0]) if (m.get("sortino90d") or 0) > 0 else None
    if m.get("tag") == "algo":
        v1 = 0.0
    return {"address": m["address"], "v1": round(v1, 1), "v2": None if v2 is None else round(v2, 1), "tag": m["tag"]}


if __name__ == "__main__":
    models = train(sys.argv[1])
    for a in sys.argv[2:]:
        print(json.dumps(score(models, metrics(a.lower()))))
