"""Coleta as listas de copytrade da Hyperdash e salva em CSV.

Uso: python3 hyperdash_fetch.py [saida.csv]
"""
import csv
import sys

import requests

URL = "https://api.hyperdash.com/graphql"
GROUPS = ["copytraders", "equities", "btc", "hype", "cl"]
QUERY = """
query GetSystemGroupTraders($groupId: ID!) {
  getSystemGroupTraders(groupId: $groupId) {
    address displayName lastTradeAt pnl perpsEquity winrate sharpe drawdown
    totalTrades pnlCohort sizeCohort tag copyScore: copyScoreV2
  }
}
"""
FIELDS = ["group", "address", "displayName", "copyScore", "pnl", "perpsEquity", "winrate",
          "sharpe", "drawdown", "totalTrades", "tag", "pnlCohort", "sizeCohort", "lastTradeAt"]


def fetch_group(group_id):
    r = requests.post(URL, json={"query": QUERY, "variables": {"groupId": group_id}},
                      headers={"Origin": "https://hyperdash.com"}, timeout=30)
    r.raise_for_status()
    return r.json()["data"]["getSystemGroupTraders"]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "hyperdash_traders.csv"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        for g in GROUPS:
            rows = fetch_group(g)
            for t in rows:
                w.writerow({"group": g, **t})
            print(f"{g}: {len(rows)} traders")
    print(f"salvo em {out}")


if __name__ == "__main__":
    main()
