# Engenharia reversa do copyScore (V2)

Objetivo: reproduzir o copyScoreV2 da Hyperdash a partir de dados públicos, com erro médio abaixo de 1 ponto
em carteiras fora da amostra. Plano completo: fases 0 a 5 (pistas diretas, amostra ampla, frequência de recálculo,
features, modelagem, validação).

## Fase 0: pistas diretas

`scripts/score/probe.py` baixa o bundle JS do site, extrai as queries GraphQL e os trechos que citam o score,
roda as queries que recebem `$address` num trader do Top 100 e sonda campos escondidos de `getTrader` pelas
mensagens de erro do GraphQL. Roda no GitHub Actions (`.github/workflows/score-research.yml`, a cada push fora
da `main` que mexa em `scripts/score/`), e as saídas ficam no artefato `probe_out`.

## Fase 1: amostra ampla (`dashboard/src/score-samples.js`)

Roda na VPS junto com o dashboard, uma vez por dia (dia UTC), à parte da coleta de 15 minutos. Leva algumas horas.

| Tabela | Conteúdo |
|---|---|
| `sample_traders` | Painel fixo de até `SAMPLE_TARGET` (8000) carteiras e a lista em que cada uma foi achada (`source`). Montado com `exploreTraders`: cortes de `minCopyScore` de 5 em 5 ordenados de baixo para cima (cobre a faixa baixa do score) e listas ordenadas por copyScore, pnl, sharpe, winrate e drawdown nas duas direções. |
| `score_samples` | Um registro por carteira e dia com o score V2 e V1 e as métricas de `getTrader`; o JSON completo (com `portfolioGraph`) em `data`. |
| `score_sample_windows` | Métricas de `exploreTraders` por janela (`one_day`, `seven_days`, `thirty_days`, `all`) das carteiras do painel que aparecem nas listas. |

A curva de portfolio da Hyperliquid de cada carteira vai para `raw/` (`kind = sample_portfolio`) na primeira vez e
depois uma vez por semana (segunda-feira).

Variáveis: `SCORE_SAMPLES=0` desliga, `SAMPLE_TARGET` (8000), `SAMPLE_DELAY_MS` (1000, pausa entre chamadas).
