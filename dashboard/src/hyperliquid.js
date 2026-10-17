const URL = 'https://api.hyperliquid.xyz/info';

export async function info(body) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return res.json();
}

export const getClearinghouseState = (user) => info({ type: 'clearinghouseState', user });
export const getPortfolio = (user) => info({ type: 'portfolio', user });

export function parsePositions(state) {
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
export function parsePortfolioPnl(data) {
  const out = {};
  for (const [period, v] of data) {
    const h = v.pnlHistory || [];
    out[period] = h.length ? Number(h.at(-1)[1]) - Number(h[0][1]) : 0;
  }
  return { day: out.day ?? 0, week: out.week ?? 0, month: out.month ?? 0, allTime: out.allTime ?? 0 };
}

// Todas as execuções desde startTime. A API devolve no máximo 2000 por chamada, então pagina pelo tempo.
export async function getFillsSince(user, startTime) {
  const fills = [];
  let from = startTime;
  for (let page = 0; page < 10; page++) {
    const batch = await info({ type: 'userFillsByTime', user, startTime: from, aggregateByTime: false });
    fills.push(...batch);
    if (batch.length < 2000) break;
    from = Math.max(...batch.map((f) => f.time)) + 1;
  }
  return fills;
}
