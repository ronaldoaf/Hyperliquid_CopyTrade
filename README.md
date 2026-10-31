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

### Paper trading (`dashboard/src/paper.js`)

Conta simulada (US$ 100 mil por padrão, sem dinheiro real) que copia os traders escolhidos:
- **Seleção semanal com histerese:** entra quem está entre os candidatos das carteiras (swing, ≥20 dias de histórico, conta ≥ US$ 10 mil, Sharpe 30d > 0) com Copy Score ≥ 85 e correlação de no máximo 0,40 com cada trader já seguido, até 10 traders; sai quem cai abaixo de 75 ou fica 3 avaliações fora da lista.
- **Run-off ao sair:** não abre nada novo, só acompanha reduções e fechamentos do trader; fecha tudo após 7 dias ou se a fatia perder 5% da alocação. Score abaixo de 45 (zona de "countertrade") fecha na hora.
- **Trader novo:** as posições que ele já tinha são ignoradas até ele zerar ou virar a mão; só copia o que abrir depois.
- **Tamanho:** 10% do patrimônio por trader, posição = a dele × alocação / conta dele. Tetos: 3x a alocação por trader, 50% do patrimônio líquido por ativo, 2x de alavancagem bruta total.
- **Custos:** taxa taker de 4,5 bps, compra no impact ask / vende no impact bid + 5 bps de slippage, funding horário.

Ciclo a cada 60 s (posições dos seguidos + preços), avaliação ao fim da coleta quando passam 7 dias. Parâmetros por variável de ambiente `PAPER_*` (lista no topo de `paper.js`); `PAPER=0` desliga. Resultado em `/api/paper` e no topo do dashboard. Testes: `cd dashboard && npm test`.

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
