# Dados coletados

Tudo fica na VPS em `/opt/copytrade-dashboard/data/`. A coleta roda a cada 15 minutos.

## Banco SQLite (`dashboard.db`)

| Tabela | Conteúdo |
|---|---|
| `group_members` | Composição dos 5 grupos da página Copytrade da Hyperdash (`copytraders` = Top 100, `equities`, `btc`, `hype`, `cl`), todos os estilos, com ranking, copyScore V2 e V1, PnL, patrimônio, winrate, sharpe, drawdown, cohort e o JSON completo em `data`. |
| `traders` | Cada carteira que já passou pelo Top 100, com o estilo (`tag`) e se ainda está nele (`in_group`). |
| `snapshots` | Por coleta e por trader do Top 100: score, valor da conta (perps principal), patrimônio da Hyperdash (`perps_equity`), PnL 24h/7d/30d/total da Hyperliquid e nº de posições. |
| `position_snapshots` | Todas as posições abertas de cada trader do Top 100 em cada coleta. |
| `positions` | Só as posições atuais (usada pelo dashboard). |
| `fills` | Todas as execuções (fills) de cada trader do Top 100, sem duplicar, desde 30 dias antes da primeira coleta dele. O JSON original fica em `raw`. |
| `runs` | Log das coletas, com erros. |

## Respostas brutas (`raw/AAAA-MM-DD.jsonl.gz`)

Uma linha JSON por resposta das APIs (`kind` = `hyperdash_group`, `clearinghouse_state` ou `portfolio`), com `ts` da coleta.
O `portfolio` traz as curvas completas de valor da conta e PnL da Hyperliquid. Para ler: `zcat raw/*.jsonl.gz` ou `gzip.open` no Python.

## Backups e exportação

- `backups/dashboard-AAAA-MM-DD.db`: cópia diária do banco, mantendo as 14 últimas.
- `GET /api/export.db`: baixa uma cópia do banco na hora. Só funciona com o secret `DASH_PASSWORD` configurado.
