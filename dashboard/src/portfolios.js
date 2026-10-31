// Monta e acompanha carteiras de 8 traders escolhidas por estratégias de seleção diferentes.
// As métricas de seleção usam os últimos 30 dias de PnL e valor da conta da Hyperliquid (janela "month"
// do portfolio), fechados por dia UTC. O retorno diário é o PnL do dia dividido pelo valor da conta na véspera,
// então depósitos e saques não contam como ganho ou perda.

const DAY = 86_400_000;
const SIZE = 8;
const MIN_DAYS = 20;
const MIN_ACCOUNT = 10_000;

// ---------- séries e estatística ----------

export function dailyReturns(portfolio) {
  const month = portfolio?.find(([period]) => period === 'month')?.[1];
  if (!month?.pnlHistory?.length) return null;
  const avAt = new Map(month.accountValueHistory.map(([t, v]) => [t, Number(v)]));
  const close = new Map();
  for (const [t, v] of month.pnlHistory) close.set(Math.floor(t / DAY), { pnl: Number(v), av: avAt.get(t) });
  const days = [...close.keys()].sort((a, b) => a - b);
  const out = new Map();
  for (let i = 1; i < days.length; i++) {
    const prev = close.get(days[i - 1]), cur = close.get(days[i]);
    if (!(prev.av >= 1000)) continue;
    // Limite de segurança contra contas quase vazias, que geram retornos absurdos.
    out.set(days[i], Math.max(-0.9, Math.min(2, (cur.pnl - prev.pnl) / prev.av)));
  }
  return out;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function aligned(a, b) {
  const xs = [], ys = [];
  for (const [d, x] of a) if (b.has(d)) { xs.push(x); ys.push(b.get(d)); }
  return [xs, ys];
}

export function correlation(a, b) {
  const [xs, ys] = aligned(a, b);
  // Sem dias suficientes em comum, assume correlação moderada em vez de fingir que é zero.
  if (xs.length < 10) return 0.5;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

function covariance(a, b) {
  const [xs, ys] = aligned(a, b);
  if (xs.length < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.length - 1);
}

// Percentil (0 a 1) de cada valor dentro da lista; maior valor = 1.
function pctRank(items, key) {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const out = new Map();
  sorted.forEach((it, i) => out.set(it.address, sorted.length > 1 ? i / (sorted.length - 1) : 1));
  return out;
}

// ---------- estratégias ----------

function topBy(pool, key) {
  return [...pool].sort((a, b) => key(b) - key(a)).slice(0, SIZE);
}

// Adiciona um a um o candidato que maximiza `gain(candidato, selecionados)`.
function greedy(pool, first, gain) {
  const chosen = first ? [first] : [];
  const rest = pool.filter((c) => c !== first);
  while (chosen.length < SIZE && rest.length) {
    let best = 0;
    for (let i = 1; i < rest.length; i++) if (gain(rest[i], chosen) > gain(rest[best], chosen)) best = i;
    chosen.push(rest.splice(best, 1)[0]);
  }
  return chosen;
}

// Escolhe pela ordem de preferência, pulando quem tem correlação acima do teto com algum já escolhido.
// Se não fechar 8, sobe o teto aos poucos.
function withCorrCap(ordered, corr, cap) {
  for (let c = cap; c <= 1.01; c += 0.1) {
    const chosen = [];
    for (const t of ordered) {
      if (chosen.every((s) => corr(s, t) <= c)) chosen.push(t);
      if (chosen.length === SIZE) return chosen;
    }
  }
  return ordered.slice(0, SIZE);
}

function clusters(pool, corr, k) {
  let groups = pool.map((t) => [t]);
  const dist = (g, h) => mean(g.flatMap((a) => h.map((b) => 1 - corr(a, b))));
  while (groups.length > k) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = dist(groups[i], groups[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }
  return groups;
}

export const STRATEGIES = [
  { slug: 'score', name: 'Maior score',
    description: 'Os 8 maiores Copy Scores da Hyperdash.',
    pick: ({ pool }) => topBy(pool, (t) => t.score) },
  { slug: 'sharpe', name: 'Maior Sharpe',
    description: 'Os 8 maiores Sharpe dos últimos 30 dias (retorno diário médio sobre o desvio, anualizado).',
    pick: ({ pool }) => topBy(pool, (t) => t.sharpe) },
  { slug: 'low-vol', name: 'Menor volatilidade',
    description: 'Entre quem teve retorno positivo em 30 dias, os 8 com menor oscilação diária.',
    pick: ({ pool }) => topBy(pool.filter((t) => t.ret30 > 0), (t) => -t.vol) },
  { slug: 'few-orders', name: 'Poucas operações',
    description: 'Entre quem tem Sharpe positivo e score acima da mediana, os 8 com menos ordens por dia.',
    pick: ({ pool, medianScore }) => topBy(pool.filter((t) => t.sharpe > 0 && t.score >= medianScore), (t) => -t.ordersPerDay) },
  { slug: 'min-corr', name: 'Menor correlação',
    description: 'Começa pelo maior score e adiciona sempre quem tem a menor correlação média com os já escolhidos (só score acima da mediana).',
    pick: ({ pool, corr, medianScore }) => {
      const p = pool.filter((t) => t.score >= medianScore);
      return greedy(p, topBy(p, (t) => t.score)[0], (c, sel) => -mean(sel.map((s) => corr(s, c))));
    } },
  { slug: 'score-decorr', name: 'Score descorrelacionado',
    description: 'Equilibra score alto e correlação baixa: adiciona quem maximiza o percentil do score menos metade da correlação média com os escolhidos.',
    pick: ({ pool, corr, ranks }) => greedy(pool, null, (c, sel) =>
      ranks.score.get(c.address) - 0.5 * (sel.length ? mean(sel.map((s) => corr(s, c))) : 0)) },
  { slug: 'sharpe-capped', name: 'Sharpe com teto de correlação',
    description: 'Do maior para o menor Sharpe, aceita só quem tem correlação de no máximo 0,3 com cada escolhido.',
    pick: ({ pool, corr }) => withCorrCap([...pool].sort((a, b) => b.sharpe - a.sharpe), corr, 0.3) },
  { slug: 'clusters', name: 'Um por grupo',
    description: 'Separa os traders em 8 grupos que se movem juntos (agrupamento por correlação) e pega o maior score de cada grupo.',
    pick: ({ pool, corr }) => clusters(pool, corr, SIZE).map((g) => topBy(g, (t) => t.score)[0]) },
  { slug: 'min-var', name: 'Mínima variância',
    description: 'Entre quem tem Sharpe positivo, adiciona sempre quem deixa a carteira de pesos iguais com a menor variância diária.',
    pick: ({ pool, cov }) => {
      const p = pool.filter((t) => t.sharpe > 0);
      const variance = (sel) => mean(sel.flatMap((a) => sel.map((b) => cov(a, b)))) ;
      return greedy(p, topBy(p, (t) => -t.vol)[0], (c, sel) => -variance([...sel, c]));
    } },
  { slug: 'composite', name: 'Composto',
    description: 'Média dos percentis de score, Sharpe, baixa volatilidade e poucas ordens; aceita só quem tem correlação de no máximo 0,5 com cada escolhido.',
    pick: ({ pool, corr, ranks }) => {
      const s = (t) => ranks.score.get(t.address) + ranks.sharpe.get(t.address) + ranks.lowVol.get(t.address) + ranks.fewOrders.get(t.address);
      return withCorrCap([...pool].sort((a, b) => s(b) - s(a)), corr, 0.5);
    } },
];

// ---------- montagem ----------

export function buildCandidates(db, portfolioByAddress, now = Date.now()) {
  const rows = db.prepare(`
    SELECT t.address, t.display_name, s.copy_score AS score, s.sharpe AS hd_sharpe, s.total_value,
      (SELECT COUNT(DISTINCT oid) FROM fills f WHERE f.address = t.address AND f.time >= :week) / 7.0 AS orders_per_day
    FROM traders t
    JOIN snapshots s ON s.address = t.address AND s.ts = (SELECT MAX(ts) FROM snapshots WHERE address = t.address)
    WHERE t.tag = 'swing' AND t.in_group = 1 AND t.high_freq = 0`).all({ week: now - 7 * DAY });
  const out = [];
  for (const r of rows) {
    const returns = dailyReturns(portfolioByAddress.get(r.address));
    if (!returns || returns.size < MIN_DAYS || !(r.total_value >= MIN_ACCOUNT) || r.score == null) continue;
    const rs = [...returns.values()];
    const vol = std(rs);
    out.push({
      address: r.address, name: r.display_name, score: r.score, hdSharpe: r.hd_sharpe,
      ordersPerDay: r.orders_per_day, accountValue: r.total_value, returns,
      vol, sharpe: vol > 0 ? (mean(rs) / vol) * Math.sqrt(365) : 0,
      ret30: rs.reduce((acc, x) => acc * (1 + x), 1) - 1,
    });
  }
  return out;
}

function portfolioStats(members, corr, cov) {
  const pairs = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.push(corr(members[i], members[j]));
  const variance = mean(members.flatMap((a) => members.map((b) => cov(a, b))));
  // Retorno de 30 dias da carteira com pesos iguais, só como referência (é o mesmo período usado na seleção).
  const days = [...new Set(members.flatMap((m) => [...m.returns.keys()]))].sort((a, b) => a - b);
  const ret30 = days.reduce((acc, d) => acc * (1 + mean(members.map((m) => m.returns.get(d) ?? 0))), 1) - 1;
  return {
    avgCorr: mean(pairs), volAnnual: Math.sqrt(Math.max(variance, 0) * 365), ret30InSample: ret30,
    avgScore: mean(members.map((m) => m.score)), avgSharpe: mean(members.map((m) => m.sharpe)),
    avgOrdersPerDay: mean(members.map((m) => m.ordersPerDay)),
  };
}

export function buildPortfolios(db, portfolioByAddress, now = Date.now()) {
  const pool = buildCandidates(db, portfolioByAddress, now);
  if (pool.length < SIZE * 2) throw new Error(`só ${pool.length} candidatos com histórico suficiente`);
  const corrCache = new Map(), covCache = new Map();
  const memo = (cache, f) => (a, b) => {
    const k = a.address < b.address ? a.address + b.address : b.address + a.address;
    if (!cache.has(k)) cache.set(k, f(a.returns, b.returns));
    return cache.get(k);
  };
  const corr = (a, b) => (a === b ? 1 : memo(corrCache, correlation)(a, b));
  const cov = (a, b) => (a === b ? a.vol ** 2 : memo(covCache, covariance)(a, b));
  const scores = pool.map((t) => t.score).sort((a, b) => a - b);
  const ctx = {
    pool, corr, cov, medianScore: scores[Math.floor(scores.length / 2)],
    ranks: {
      score: pctRank(pool, (t) => t.score), sharpe: pctRank(pool, (t) => t.sharpe),
      lowVol: pctRank(pool, (t) => -t.vol), fewOrders: pctRank(pool, (t) => -t.ordersPerDay),
    },
  };

  const insertP = db.prepare('INSERT INTO portfolios (slug, name, description, created_at, metrics) VALUES (?, ?, ?, ?, ?)');
  const insertM = db.prepare('INSERT INTO portfolio_members (portfolio_id, address, weight, metrics) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const s of STRATEGIES) {
      const members = s.pick(ctx).filter(Boolean);
      const stats = { ...portfolioStats(members, corr, cov), candidates: pool.length };
      const id = Number(insertP.run(s.slug, s.name, s.description, now, JSON.stringify(stats)).lastInsertRowid);
      for (const m of members) {
        insertM.run(id, m.address, 1 / members.length, JSON.stringify({
          score: m.score, sharpe30: m.sharpe, hdSharpe: m.hdSharpe, vol: m.vol, ret30: m.ret30,
          ordersPerDay: m.ordersPerDay, accountValue: m.accountValue,
        }));
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[portfolios] ${STRATEGIES.length} carteiras montadas a partir de ${pool.length} candidatos`);
}

// ---------- acompanhamento ----------

// Cada membro começa com 1/8 do capital e segue sem rebalancear (como copiar cada trader com valor fixo).
// O retorno de cada intervalo é a variação do PnL total dividida pelo valor total da conta no início dele.
export function trackPortfolios(db) {
  const portfolios = db.prepare('SELECT * FROM portfolios ORDER BY id').all();
  const membersOf = db.prepare(`SELECT m.address, m.weight, m.metrics, t.display_name, t.in_group, t.tag
    FROM portfolio_members m LEFT JOIN traders t USING (address) WHERE m.portfolio_id = ?`);
  const snaps = db.prepare(`SELECT ts, pnl_all_time, total_value FROM snapshots
    WHERE address = ? AND ts >= ? ORDER BY ts`);
  const runTs = db.prepare('SELECT ts FROM runs WHERE ok = 1 AND ts >= ? ORDER BY ts');

  return portfolios.map((p) => {
    const timeline = runTs.all(p.created_at).map((r) => r.ts);
    const members = membersOf.all(p.id).map((m) => {
      const byTs = new Map(snaps.all(m.address, p.created_at).map((s) => [s.ts, s]));
      let value = 1, prev = null;
      const values = timeline.map((ts) => {
        const s = byTs.get(ts);
        if (s) {
          if (prev && prev.total_value >= 100) value *= 1 + Math.max(-0.9, Math.min(2, (s.pnl_all_time - prev.pnl_all_time) / prev.total_value));
          prev = s;
        }
        return value;
      });
      return { address: m.address, name: m.display_name, weight: m.weight, inGroup: m.in_group,
        selection: JSON.parse(m.metrics || '{}'), values, return: value - 1 };
    });
    const nav = timeline.map((ts, i) => [ts, members.reduce((acc, m) => acc + m.weight * m.values[i], 0)]);
    let peak = 1, maxDd = 0;
    for (const [, v] of nav) { peak = Math.max(peak, v); maxDd = Math.min(maxDd, v / peak - 1); }
    return {
      id: p.id, slug: p.slug, name: p.name, description: p.description, createdAt: p.created_at,
      selection: JSON.parse(p.metrics || '{}'),
      return: nav.length ? nav.at(-1)[1] - 1 : 0, maxDrawdown: maxDd, nav,
      members: members.map(({ values, ...m }) => m).sort((a, b) => b.return - a.return),
    };
  });
}
