import { appendRaw } from './archive.js';
import { getPortfolio } from './hyperliquid.js';

// Amostra ampla para a engenharia reversa do copyScore (fase 1, docs/copyscore.md).
// Um painel fixo de carteiras cobrindo toda a faixa de score, coletado uma vez por dia.

const URL = 'https://api.hyperdash.com/graphql';
const TIMEFRAMES = ['one_day', 'seven_days', 'thirty_days', 'all'];
const SORT_FIELDS = ['copyScore', 'pnl', 'sharpe', 'winrate', 'drawdown'];
const EXPLORE_FIELDS = `address pnl perpsEquity winrate sharpe drawdown totalTrades tag
  copyScore: copyScoreV2 copyScoreV1: copyScore`;
const TRADER_FIELDS = `address label displayName lastTradeAt lastFillAt pnl perpsEquity winrate pnlCohort sizeCohort
  totalTrades totalLongTrades totalShortTrades totalWinningTrades totalLosingTrades
  sharpe drawdown copyScore: copyScoreV2 copyScoreV1: copyScore tag
  portfolioGraph { timestamp value } topAssets { coin volume pnl }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bind = (...values) => values.map((v) => (v === undefined || Number.isNaN(v) ? null : v));

async function gql(query, variables) {
  for (let i = 0; ; i++) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://hyperdash.com' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && i < 3) {
      await sleep(10_000 * 2 ** i);
      continue;
    }
    if (!res.ok) throw new Error(`Hyperdash HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Hyperdash: ${json.errors[0].message}`);
    return json.data;
  }
}

const explore = (variables) => gql(`
  query($page: Int, $pageSize: Int, $timeframe: TraderTimeframe!, $sortBy: TraderSortInput, $filters: TraderFilterInput) {
    exploreTraders(page: $page, pageSize: $pageSize, timeframe: $timeframe, sortBy: $sortBy, filters: $filters) {
      data { ${EXPLORE_FIELDS} }
    }
  }`, { pageSize: 100, ...variables }).then((d) => d.exploreTraders.data);

const getTrader = (address) => gql(`
  query($address: String!) { getTrader(address: $address, includePortfolioGraph: true) { ${TRADER_FIELDS} } }`,
{ address }).then((d) => d.getTrader);

export function migrateScoreSamples(db) {
  db.exec(`
    -- Painel fixo de carteiras da amostra, com a lista de origem (como foi encontrada).
    CREATE TABLE IF NOT EXISTS sample_traders (
      address TEXT PRIMARY KEY, source TEXT, added_at INTEGER NOT NULL
    );
    -- Um registro por carteira e dia: score V2 e V1 e as métricas de getTrader (JSON completo em data).
    CREATE TABLE IF NOT EXISTS score_samples (
      day TEXT NOT NULL, ts INTEGER NOT NULL, address TEXT NOT NULL, copy_score REAL, copy_score_v1 REAL,
      pnl REAL, perps_equity REAL, winrate REAL, sharpe REAL, drawdown REAL, total_trades INTEGER,
      tag TEXT, pnl_cohort TEXT, size_cohort TEXT, last_trade_at INTEGER, data TEXT,
      PRIMARY KEY (day, address)
    );
    -- Métricas de exploreTraders por janela (pnl, winrate, sharpe, drawdown de 1d, 7d, 30d e total).
    CREATE TABLE IF NOT EXISTS score_sample_windows (
      day TEXT NOT NULL, timeframe TEXT NOT NULL, address TEXT NOT NULL, copy_score REAL, copy_score_v1 REAL,
      pnl REAL, perps_equity REAL, winrate REAL, sharpe REAL, drawdown REAL, total_trades INTEGER,
      PRIMARY KEY (day, timeframe, address)
    );
  `);
}

// Monta o painel: listas ordenadas por cada métrica, nas duas direções, e cortes de minCopyScore
// em ordem crescente para pegar carteiras logo acima de cada patamar (cobre a faixa baixa do score).
async function buildPanel(db, { target, delayMs }) {
  const have = db.prepare('SELECT COUNT(*) AS n FROM sample_traders').get().n;
  if (have >= target) return 0;
  const insert = db.prepare('INSERT OR IGNORE INTO sample_traders (address, source, added_at) VALUES (?, ?, ?)');
  const queries = [];
  for (let min = 0; min <= 95; min += 5) {
    queries.push({ source: `min${min}`, timeframe: 'all', sortBy: { field: 'copyScore', order: 'asc' },
      filters: { minCopyScore: min }, pages: 3 });
  }
  for (const field of SORT_FIELDS) {
    for (const order of ['desc', 'asc']) {
      for (const timeframe of ['thirty_days', 'all']) {
        queries.push({ source: `${field}_${order}_${timeframe}`, timeframe, sortBy: { field, order }, pages: 5 });
      }
    }
  }
  let added = 0;
  for (const q of queries) {
    for (let page = 1; page <= q.pages; page++) {
      if (have + added >= target) return added;
      let rows;
      try {
        rows = await explore({ page, timeframe: q.timeframe, sortBy: q.sortBy, filters: q.filters });
      } catch (err) {
        console.error(`[samples] explore ${q.source} p${page}: ${err.message}`);
        break;
      }
      await sleep(delayMs);
      if (!rows?.length) break;
      for (const r of rows) added += insert.run(r.address.toLowerCase(), q.source, Date.now()).changes;
    }
  }
  return added;
}

// Grava as métricas por janela de quem está no painel, varrendo as listas de exploreTraders.
async function collectWindows(db, day, panel, delayMs) {
  const insert = db.prepare(`INSERT OR REPLACE INTO score_sample_windows (day, timeframe, address, copy_score,
    copy_score_v1, pnl, perps_equity, winrate, sharpe, drawdown, total_trades) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const timeframe of TIMEFRAMES) {
    for (const field of SORT_FIELDS) {
      for (const order of ['desc', 'asc']) {
        for (let page = 1; page <= 10; page++) {
          let rows;
          try {
            rows = await explore({ page, timeframe, sortBy: { field, order } });
          } catch (err) {
            console.error(`[samples] janela ${timeframe} ${field}: ${err.message}`);
            break;
          }
          await sleep(delayMs);
          if (!rows?.length) break;
          for (const r of rows) {
            const address = r.address.toLowerCase();
            if (!panel.has(address)) continue;
            insert.run(...bind(day, timeframe, address, r.copyScore, r.copyScoreV1, Number(r.pnl),
              Number(r.perpsEquity), r.winrate, r.sharpe, r.drawdown, r.totalTrades));
          }
        }
      }
    }
  }
}

export async function collectScoreSamples(db, { rawDir, target = 8000, delayMs = 1000, portfolioWeekday = 1 }) {
  const ts = Date.now();
  const day = new Date(ts).toISOString().slice(0, 10);
  const done = db.prepare('SELECT COUNT(*) AS n FROM score_samples WHERE day = ?').get(day).n;
  if (done > 0) return null;

  const added = await buildPanel(db, { target, delayMs });
  const panel = new Set(db.prepare('SELECT address FROM sample_traders').all().map((r) => r.address));
  console.log(`[samples] ${day}: painel com ${panel.size} carteiras (+${added})`);

  await collectWindows(db, day, panel, delayMs);

  const insert = db.prepare(`INSERT OR REPLACE INTO score_samples (day, ts, address, copy_score, copy_score_v1,
    pnl, perps_equity, winrate, sharpe, drawdown, total_trades, tag, pnl_cohort, size_cohort, last_trade_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A curva da Hyperliquid é pesada: só uma vez por semana, ou na primeira vez que a carteira aparece.
  const hasPortfolio = new Set(db.prepare('SELECT DISTINCT address FROM score_samples').all().map((r) => r.address));
  const weekly = new Date(ts).getUTCDay() === portfolioWeekday;
  let ok = 0, failures = 0;
  for (const address of panel) {
    try {
      const t = await getTrader(address);
      await sleep(delayMs);
      insert.run(...bind(day, ts, address, t?.copyScore, t?.copyScoreV1, Number(t?.pnl), Number(t?.perpsEquity),
        t?.winrate, t?.sharpe, t?.drawdown, t?.totalTrades, t?.tag, t?.pnlCohort, t?.sizeCohort,
        t?.lastTradeAt, JSON.stringify(t)));
      if (weekly || !hasPortfolio.has(address)) {
        const portfolio = await getPortfolio(address);
        appendRaw(rawDir, ts, [{ kind: 'sample_portfolio', address, data: portfolio }]);
        await sleep(delayMs);
      }
      ok++;
    } catch (err) {
      failures++;
      if (failures <= 20) console.error(`[samples] ${address}: ${err.message}`);
    }
  }
  console.log(`[samples] ${day}: ${ok} carteiras gravadas, ${failures} falhas, ${Math.round((Date.now() - ts) / 60000)} min`);
  return { day, ok, failures };
}
