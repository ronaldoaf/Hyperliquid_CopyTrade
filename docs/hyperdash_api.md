# Hyperdash: API pública do Copy Score

Investigado em 2026-10-17 pelo navegador (sem login; o magic link não abriu sessão, provavelmente expirado ou já usado).

## Endpoint
`POST https://api.hyperdash.com/graphql` (JSON `{query, variables}`), sem autenticação nem cookies.
Introspecção desativada; queries extraídas do bundle do site (`/assets/index-*.js`).
Não vi headers de rate limit; 20 chamadas seguidas a ~260 ms cada, todas 200.

## Queries úteis

### 1. Listas curadas da página Copytrade (100 traders cada)
```graphql
query GetSystemGroupTraders($groupId: ID!) {
  getSystemGroupTraders(groupId: $groupId) {
    address label displayName twitter lastTradeAt lastFillAt
    portfolioGraph { timestamp value }
    pnl perpsEquity winrate pnlCohort sizeCohort
    totalTrades totalLongTrades totalShortTrades totalWinningTrades totalLosingTrades
    sharpe drawdown copyScore: copyScoreV2 tag
    topAssets { coin volume pnl }
  }
}
```
`groupId`: `copytraders` (Top 100, scores 82 a 96), `equities` (100), `btc` (100), `hype` (100), `cl` (40).

### 2. Score de qualquer carteira
```graphql
query($address: String!) {
  getTrader(address: $address, includePortfolioGraph: false) {
    address pnl perpsEquity winrate sharpe drawdown tag
    copyScore: copyScoreV2   # o que o site mostra (0-100)
    copyScoreV1: copyScore   # versão antiga
  }
}
```
Carteira sem histórico volta `copyScoreV2: null`.

### 3. Explorar toda a base (~1,73 milhão de carteiras)
```graphql
query ExploreTraders($page: Int, $pageSize: Int, $timeframe: TraderTimeframe!,
                     $sortBy: TraderSortInput, $filters: TraderFilterInput) {
  exploreTraders(page: $page, pageSize: $pageSize, timeframe: $timeframe,
                 sortBy: $sortBy, filters: $filters) {
    data { address pnl perpsEquity winrate sharpe drawdown totalTrades tag copyScore: copyScoreV2 }
    pagination { page pageSize totalItems totalPages }
  }
}
```
- `timeframe`: `one_day`, `seven_days`, `thirty_days`, `all`
- `sortBy: {field, order}`, `order` = `desc`/`asc`; `field` aceita `copyScore`, `pnl`, `sharpe`, `winrate`, `drawdown`
- `pageSize` máximo 100; paginação profunda parece limitada (página 50 voltou vazia)
- **Atenção:** ordenar por `copyScore` ordena pelo V1, não pelo V2 exibido no site
- `filters`: aceita `minCopyScore` e `tag`; outros nomes ainda não descobertos

### Outras queries no bundle (não testadas)
`GetTraderDetailedStatsSummary`, `GetTraderCompletedTrades`, `GetTraderBestTrades`,
`GetTraderStatsPerAsset`, `GetTradersPnl90d(addresses: [...])`, `GetAssetTopTraders`.

## Ressalvas
- API não documentada: pode mudar ou ser bloqueada sem aviso. Vale guardar snapshots.
- A fórmula do copyScoreV2 não é pública.
