const URL = 'https://api.hyperdash.com/graphql';

const GROUP_QUERY = `
query GetSystemGroupTraders($groupId: ID!) {
  getSystemGroupTraders(groupId: $groupId) {
    address displayName lastTradeAt pnl perpsEquity winrate sharpe drawdown
    totalTrades tag copyScore: copyScoreV2
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
