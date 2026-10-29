"""Compara as métricas de hl_metrics.py com as da Hyperdash numa amostra de carteiras.

Uso: python3 validate_metrics.py hyperdash_traders.json N saida.json
"""
import json
import random
import sys

from hl_metrics import metrics

COLS = ["sharpe90d", "sortino90d", "drawdown90d", "sharpe365d", "sortino365d", "drawdown365d",
        "winrate30d", "winrate90d", "winrate365d", "trades30d", "tag"]

hd = [t for t in json.load(open(sys.argv[1])) if t.get("copyScoreV2") is not None or (t.get("copyScore") or 0) > 0]
random.seed(1)
out = []
for t in random.sample(hd, int(sys.argv[2])):
    try:
        m = metrics(t["address"])
    except Exception as e:  # carteira com dados demais ou erro da API: segue para a próxima
        print(t["address"], "erro", e, flush=True)
        continue
    m["equity_hd"] = t["perpsEquity"]
    out.append({"address": t["address"], "hd": {c: t.get(c) for c in COLS}, "hl": m})
    print(t["address"], {c: (t.get(c), m.get(c)) for c in COLS[:3]}, flush=True)
    json.dump(out, open(sys.argv[3], "w"))
