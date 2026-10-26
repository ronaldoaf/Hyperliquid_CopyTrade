# Dados coletados

Tudo fica na VPS em `/opt/copytrade-dashboard/data/`. A coleta roda a cada 15 minutos.

## Banco SQLite (`dashboard.db`)

| Tabela | Conteúdo |
|---|---|
| `group_members` | Composição dos 5 grupos da página Copytrade da Hyperdash (`copytraders` = Top 100, `equities`, `btc`, `hype`, `cl`), todos os estilos, com ranking, copyScore V2 e V1, PnL, patrimônio, winrate, sharpe, drawdown, cohort e o JSON completo em `data`. |
| `traders` | Cada carteira que já passou pelo Top 100, com o estilo (`tag`), se ainda está nele (`in_group`) e se opera demais para ser copiada (`high_freq`). |
| `snapshots` | Por coleta e por trader do Top 100: score, valor da conta (perps principal), patrimônio da Hyperdash (`perps_equity`), PnL 24h/7d/30d/total da Hyperliquid e nº de posições. |
| `position_snapshots` | Todas as posições abertas de cada trader do Top 100 em cada coleta. |
| `positions` | Só as posições atuais (usada pelo dashboard). |
| `fills` | Todas as execuções (fills) de cada trader do Top 100, sem duplicar, desde 30 dias antes da primeira coleta dele. O JSON original fica em `raw`. |
| `runs` | Log das coletas, com erros. |

## Carteiras

`portfolios` e `portfolio_members` guardam as 10 carteiras de 8 traders montadas na primeira coleta após o deploy
(`dashboard/src/portfolios.js`). Candidatos: traders swing do Top 100, fora da alta frequência, com pelo menos 20 dias de
histórico e conta de US$ 10 mil ou mais. As métricas de seleção usam os 30 dias anteriores (janela `month` do portfolio da
Hyperliquid, fechada por dia UTC): retorno diário = PnL do dia / valor da conta na véspera; volatilidade = desvio do retorno
diário; Sharpe = média / desvio × √365; correlação de Pearson entre os retornos diários.

O acompanhamento começa na criação: cada trader recebe 1/8 do capital, sem rebalancear, e o retorno de cada coleta é a variação
do PnL total dividida pelo valor total da conta (`snapshots.total_value`). Quem sai do Top 100 continua sendo coletado enquanto
estiver em alguma carteira.

## Traders de alta frequência

Quem passa de 20 ordens por dia em média nos últimos 7 dias (`MAX_ORDERS_PER_DAY`) é marcado com `high_freq = 1` de forma permanente:
sai do dashboard e deixa de ter as execuções coletadas. O score, a conta e as posições continuam sendo gravados.
As execuções já coletadas antes da marcação ficam no banco. `GET /api/fill-stats` mostra ordens e execuções por trader.

## Respostas brutas (`raw/AAAA-MM-DD.jsonl.gz`)

Uma linha JSON por resposta das APIs (`kind` = `hyperdash_group`, `clearinghouse_state` ou `portfolio`), com `ts` da coleta.
O `portfolio` (gravado uma vez por hora) traz as curvas completas de valor da conta e PnL da Hyperliquid. Para ler: `zcat raw/*.jsonl.gz` ou `gzip.open` no Python.

## Backups e exportação

- `backups/dashboard-AAAA-MM-DD.db`: cópia diária do banco, mantendo as 3 últimas.
- `GET /api/export.db`: baixa uma cópia do banco na hora. Só funciona com o secret `DASH_PASSWORD` configurado.
