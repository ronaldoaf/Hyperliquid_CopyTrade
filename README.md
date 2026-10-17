# Hyperliquid CopyTrade

Sistema automatizado para encontrar traders lucrativos na Hyperliquid e copiar suas operações.

## Estado atual

- `docs/hyperdash_api.md`: API GraphQL pública da Hyperdash, que expõe o Copy Score (0-100) e as métricas de cada trader.
- `scripts/hyperdash_fetch.py`: baixa as listas curadas da página Copytrade da Hyperdash (Top 100, ações, BTC, HYPE, CL) para um CSV.

## Uso

```bash
pip install -r requirements.txt
python3 scripts/hyperdash_fetch.py traders.csv
```

## Próximos passos

- Combinar o Copy Score da Hyperdash com a busca de carteiras do Hyperliquid_Wallet_Finder.
- Acompanhar as posições das carteiras escolhidas e replicar as ordens.
