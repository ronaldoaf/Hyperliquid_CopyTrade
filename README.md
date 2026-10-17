# Hyperliquid CopyTrade

Sistema automatizado para encontrar traders lucrativos na Hyperliquid e copiar suas operações.

## Estado atual

- `docs/hyperdash_api.md`: API GraphQL pública da Hyperdash, que expõe o Copy Score (0-100) e as métricas de cada trader.
- `scripts/hyperdash_fetch.py`: baixa as listas curadas da página Copytrade da Hyperdash (Top 100, ações, BTC, HYPE, CL) para um CSV.

## Dashboard (`dashboard/`)

Servidor Node.js (sem dependências, usa `node:sqlite`) que a cada 15 minutos:
- pega o Top 100 da Hyperdash por Copy Score e mantém só os traders "Swing de médio prazo" (`tag = swing`);
- busca na Hyperliquid o valor da conta, as posições abertas e o PnL de 24h, 7d e 30d de cada um;
- guarda tudo em SQLite (`dashboard/data/`) e mostra o PnL somado desde o início do acompanhamento;
- arquiva, para pesquisa de estratégia, os 5 grupos da Hyperdash, as posições e as execuções de todo o Top 100 e as respostas brutas das APIs (veja `docs/dados.md`).

Roda em `http://217.217.251.30:8080`. O deploy é automático (`.github/workflows/deploy.yml`) a cada push na `main` que mexa em `dashboard/`.
Secrets usados: `VPS_SSH_KEY` (obrigatório) e `DASH_PASSWORD` (senha do dashboard, usuário `admin`).

Rodar localmente: `cd dashboard && node server.js` (Node 22.13 ou mais novo).

## Uso do script Python

```bash
pip install -r requirements.txt
python3 scripts/hyperdash_fetch.py traders.csv
```

## Próximos passos

- Combinar o Copy Score da Hyperdash com a busca de carteiras do Hyperliquid_Wallet_Finder.
- Acompanhar as posições das carteiras escolhidas e replicar as ordens.
