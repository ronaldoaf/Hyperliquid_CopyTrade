const URL = 'https://api.hyperliquid.xyz/info';

async function info(body) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return res.json();
}

export async function getPositions(user) {
  const state = await info({ type: 'clearinghouseState', user });
  return {
    accountValue: Number(state.marginSummary?.accountValue ?? 0),
    positions: (state.assetPositions || []).map(({ position: p }) => ({
      coin: p.coin,
      size: Number(p.szi),
      entryPx: Number(p.entryPx),
      positionValue: Number(p.positionValue),
      unrealizedPnl: Number(p.unrealizedPnl),
      leverage: p.leverage?.value ?? null,
      liquidationPx: p.liquidationPx == null ? null : Number(p.liquidationPx),
    })),
  };
}

// PnL de cada janela, vindo do histórico da própria Hyperliquid (não é afetado por depósitos e saques).
export async function getPortfolioPnl(user) {
  const data = await info({ type: 'portfolio', user });
  const out = {};
  for (const [period, v] of data) {
    const h = v.pnlHistory || [];
    out[period] = h.length ? Number(h.at(-1)[1]) - Number(h[0][1]) : 0;
  }
  return { day: out.day ?? 0, week: out.week ?? 0, month: out.month ?? 0, allTime: out.allTime ?? 0 };
}
