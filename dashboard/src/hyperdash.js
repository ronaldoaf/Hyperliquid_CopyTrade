const URL = 'https://api.hyperdash.com/graphql';

// Grupos da página Copytrade: Top 100, ações, BTC, HYPE e CL.
export const GROUPS = ['copytraders', 'equities', 'btc', 'hype', 'cl'];

const GROUP_QUERY = `
query GetSystemGroupTraders($groupId: ID!) {
  getSystemGroupTraders(groupId: $groupId) {
    address label verified displayName twitter lastTradeAt lastFillAt
    pnl perpsEquity winrate pnlCohort sizeCohort
    totalTrades totalLongTrades totalShortTrades totalWinningTrades totalLosingTrades
    sharpe drawdown copyScore: copyScoreV2 copyScoreV1: copyScore tag
    topAssets { coin volume pnl }
  }
}`;

export async function getGroupTraders(groupId) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://hyperdash.com' },
    body: JSON.stringify({ query: GROUP_QUERY, variables: { groupId } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Hyperdash HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Hyperdash: ${json.errors[0].message}`);
  return json.data.getSystemGroupTraders;
}
