// Paper trading de copytrading: segue traders escolhidos toda semana e replica as posições deles numa conta
// simulada, com taxas, slippage e funding. Nenhuma ordem real é enviada.
//
// Regras:
// - Seleção semanal com histerese: entra quem tem score >= enterScore (até maxTraders); sai na hora (run-off)
//   quem cai abaixo de exitScore; quem só sai da lista de candidatos sai depois de maxMisses avaliações seguidas.
// - Trader novo: as posições que ele já tinha ao entrar são ignoradas; só copia o que abrir dali em diante.
// - Alocação fixa por trader (allocFrac do patrimônio, refeita a cada avaliação). A posição copiada é a dele
//   vezes alocação / valor da conta dele, com teto de alavancagem por trader, por ativo e total.
// - Run-off ao deixar de seguir: não abre nada novo, só acompanha reduções e fechamentos dele. Fecha tudo ao fim
//   de runoffDays ou se o PnL da fatia cair runoffStop da alocação desde o início do run-off.
//   Se o motivo da saída for risco, fecha na hora.
import { info, parsePositions } from './hyperliquid.js';
import { buildCandidates } from './portfolios.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));

export const PAPER = {
  capital: env('PAPER_CAPITAL', 100_000),
  maxTraders: env('PAPER_MAX_TRADERS', 6),
  allocFrac: env('PAPER_ALLOC', 0.15),
  enterScore: env('PAPER_ENTER_SCORE', 85),
  exitScore: env('PAPER_EXIT_SCORE', 75),
  // Abaixo disso a Hyperdash sugere "countertrade": sai na hora em vez de fazer run-off.
  riskScore: env('PAPER_RISK_SCORE', 45),
  maxMisses: env('PAPER_MAX_MISSES', 3),
  evalEveryDays: env('PAPER_EVAL_DAYS', 7),
  traderLeverage: env('PAPER_TRADER_LEV', 3), // nocional da fatia / alocação
  assetCap: env('PAPER_ASSET_CAP', 0.5), // |nocional líquido por ativo| / patrimônio
  totalLeverage: env('PAPER_TOTAL_LEV', 2), // nocional bruto / patrimônio
  feeBps: env('PAPER_FEE_BPS', 4.5), // taxa taker da Hyperliquid no nível base
  slippageBps: env('PAPER_SLIPPAGE_BPS', 5), // além do spread (compra no impact ask, vende no impact bid)
  minTradeUsd: env('PAPER_MIN_TRADE', 10),
  // Ajustes menores que essa fração da posição alvo são ignorados, para não girar à toa.
  minTradeFrac: env('PAPER_MIN_TRADE_FRAC', 0.05),
  runoffDays: env('PAPER_RUNOFF_DAYS', 7),
  runoffStop: env('PAPER_RUNOFF_STOP', 0.05),
  intervalSec: env('PAPER_INTERVAL_SEC', 60),
};

export function migratePaper(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_state (key TEXT PRIMARY KEY, value TEXT);
    -- status: active (copiando), runoff (só reduz), closed.
    CREATE TABLE IF NOT EXISTS paper_followers (
      address TEXT PRIMARY KEY, status TEXT NOT NULL, alloc REAL NOT NULL, score REAL,
      entered_at INTEGER NOT NULL, misses INTEGER NOT NULL DEFAULT 0, baseline TEXT,
      runoff_at INTEGER, runoff_pnl REAL, exit_reason TEXT, closed_at INTEGER
    );
    -- Posição copiada de cada trader em cada ativo (a linha fica depois de zerada, com o acumulado).
    CREATE TABLE IF NOT EXISTS paper_legs (
      address TEXT NOT NULL, coin TEXT NOT NULL, size REAL NOT NULL DEFAULT 0, entry_px REAL,
      realized REAL NOT NULL DEFAULT 0, fees REAL NOT NULL DEFAULT 0, funding REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (address, coin)
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      ts INTEGER NOT NULL, address TEXT NOT NULL, coin TEXT NOT NULL, size REAL NOT NULL, px REAL NOT NULL,
      mid REAL, fee REAL NOT NULL, realized REAL NOT NULL, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS paper_trades_ts ON paper_trades (ts);
    CREATE TABLE IF NOT EXISTS paper_equity (
      ts INTEGER PRIMARY KEY, equity REAL NOT NULL, cash REAL NOT NULL, gross REAL NOT NULL, followers INTEGER
    );
    CREATE TABLE IF NOT EXISTS paper_evaluations (ts INTEGER PRIMARY KEY, data TEXT NOT NULL);
  `);
  if (!getState(db, 'cash')) {
    setState(db, 'cash', PAPER.capital);
    setState(db, 'started_at', Date.now());
  }
}

function getState(db, key) {
  const v = db.prepare('SELECT value FROM paper_state WHERE key = ?').get(key)?.value;
  return v == null ? null : JSON.parse(v);
}
function setState(db, key, value) {
  db.prepare('INSERT INTO paper_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- funções puras (testadas em test/paper.test.js) ----------

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// Tamanho alvo de cada ativo para um trader seguido, antes dos tetos globais.
// baseline: {coin: sinal da posição dele quando começamos a seguir}; é alterado no lugar quando ele zera ou vira.
export function traderTargets({ status, alloc, accountValue, positions, legs, baseline, prices, cfg = PAPER }) {
  const out = {};
  const coins = new Set([...Object.keys(positions), ...Object.keys(legs), ...Object.keys(baseline)]);
  const ratio = accountValue > 0 ? alloc / accountValue : 0;
  for (const coin of coins) {
    const theirs = positions[coin] ?? 0;
    const ours = legs[coin] ?? 0;
    if (baseline[coin] !== undefined) {
      if (sign(theirs) === baseline[coin]) { out[coin] = ours; continue; }
      delete baseline[coin];
    }
    if (!prices[coin]) { out[coin] = ours; continue; } // ativo sem preço (ex.: HIP-3): não mexe
    const raw = theirs * ratio;
    out[coin] = status === 'runoff'
      ? (sign(raw) === sign(ours) ? sign(ours) * Math.min(Math.abs(ours), Math.abs(raw)) : 0)
      : raw;
  }
  // Teto de alavancagem da fatia, só na parte que segue o trader.
  if (status === 'active') {
    const gross = Object.entries(out).reduce((s, [c, sz]) => s + Math.abs(sz) * (prices[c]?.mid ?? 0), 0);
    const cap = cfg.traderLeverage * alloc;
    if (gross > cap) for (const c of Object.keys(out)) if (prices[c]) out[c] *= cap / gross;
  }
  return out;
}

// Aplica os tetos por ativo (líquido) e total (bruto). targets: {address: {coin: size}}.
export function applyCaps(targets, prices, equity, cfg = PAPER) {
  const net = {};
  for (const t of Object.values(targets)) for (const [c, sz] of Object.entries(t)) net[c] = (net[c] ?? 0) + sz;
  for (const [c, n] of Object.entries(net)) {
    const px = prices[c]?.mid;
    const cap = cfg.assetCap * equity;
    if (px && Math.abs(n) * px > cap) for (const t of Object.values(targets)) if (t[c]) t[c] *= cap / (Math.abs(n) * px);
  }
  let gross = 0;
  for (const t of Object.values(targets)) for (const [c, sz] of Object.entries(t)) gross += Math.abs(sz) * (prices[c]?.mid ?? 0);
  const cap = cfg.totalLeverage * equity;
  if (gross > cap) for (const t of Object.values(targets)) for (const c of Object.keys(t)) if (prices[c]) t[c] *= cap / gross;
  return targets;
}

// Preço de execução simulado: atravessa o spread (impact price) e paga slippage extra.
export function fillPrice(p, size, cfg = PAPER) {
  const slip = cfg.slippageBps / 10_000;
  return size > 0 ? Math.max(p.ask ?? p.mid, p.mid) * (1 + slip) : Math.min(p.bid ?? p.mid, p.mid) * (1 - slip);
}

// Executa `delta` sobre a perna (size, entryPx). Devolve a perna nova, o PnL realizado e a taxa.
export function applyFill(leg, delta, px, cfg = PAPER) {
  const fee = Math.abs(delta) * px * cfg.feeBps / 10_000;
  let { size, entryPx } = leg;
  let realized = 0;
  if (size === 0 || sign(size) === sign(delta)) {
    entryPx = size === 0 ? px : (entryPx * Math.abs(size) + px * Math.abs(delta)) / (Math.abs(size) + Math.abs(delta));
    size += delta;
  } else {
    const closing = Math.min(Math.abs(delta), Math.abs(size));
    realized = closing * (px - entryPx) * sign(size);
    size += delta;
    if (Math.abs(size) < 1e-12) { size = 0; entryPx = null; }
    else if (sign(size) !== sign(leg.size)) entryPx = px; // virou de lado
  }
  return { size, entryPx, realized, fee };
}

export function shouldTrade(current, target, px, cfg = PAPER) {
  const delta = target - current;
  if (delta === 0) return false;
  if (target === 0) return true; // fechar sempre fecha
  const notional = Math.abs(delta) * px;
  return notional >= cfg.minTradeUsd && Math.abs(delta) >= cfg.minTradeFrac * Math.abs(target);
}

// Decide quem entra, quem sai e por quê. candidates: [{address, score}], followers: linhas ativas.
export function evaluate(candidates, followers, cfg = PAPER) {
  const byAddr = new Map(candidates.map((c) => [c.address, c]));
  const actions = [];
  let active = 0;
  for (const f of followers.filter((x) => x.status === 'active')) {
    const c = byAddr.get(f.address);
    if (c && c.score < cfg.riskScore) actions.push({ address: f.address, action: 'close', reason: `risco: score ${c.score.toFixed(1)}` });
    else if (c && c.score < cfg.exitScore) actions.push({ address: f.address, action: 'runoff', reason: `score ${c.score.toFixed(1)} < ${cfg.exitScore}` });
    else if (!c && f.misses + 1 >= cfg.maxMisses) actions.push({ address: f.address, action: 'runoff', reason: `${f.misses + 1} avaliações fora da lista` });
    else { actions.push({ address: f.address, action: c ? 'keep' : 'miss', score: c?.score }); active++; }
  }
  const busy = new Set(followers.filter((x) => x.status !== 'closed').map((x) => x.address));
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (active >= cfg.maxTraders) break;
    if (busy.has(c.address) || !(c.score >= cfg.enterScore)) continue;
    actions.push({ address: c.address, action: 'enter', score: c.score });
    active++;
  }
  return actions;
}

// ---------- mercado ----------

export async function getPrices() {
  const [meta, ctxs] = await info({ type: 'metaAndAssetCtxs' });
  const out = {};
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    const mid = Number(c.midPx ?? c.markPx);
    if (!mid || u.isDelisted) return;
    out[u.name] = {
      mid, mark: Number(c.markPx), funding: Number(c.funding),
      bid: c.impactPxs ? Number(c.impactPxs[0]) : mid, ask: c.impactPxs ? Number(c.impactPxs[1]) : mid,
    };
  });
  return out;
}

// ---------- motor ----------

function loadLegs(db) {
  const legs = new Map();
  for (const l of db.prepare('SELECT * FROM paper_legs').all()) {
    if (!legs.has(l.address)) legs.set(l.address, {});
    legs.get(l.address)[l.coin] = l;
  }
  return legs;
}

export function accountSummary(db, prices) {
  const cash = getState(db, 'cash');
  let unrealized = 0, gross = 0;
  for (const l of db.prepare('SELECT * FROM paper_legs WHERE size != 0').all()) {
    const px = prices?.[l.coin]?.mark ?? l.entry_px;
    unrealized += l.size * (px - l.entry_px);
    gross += Math.abs(l.size) * px;
  }
  return { cash, unrealized, equity: cash + unrealized, gross };
}

function slicePnl(db, address, prices) {
  let pnl = 0;
  for (const l of db.prepare('SELECT * FROM paper_legs WHERE address = ?').all(address)) {
    pnl += l.realized + l.funding - l.fees;
    if (l.size) pnl += l.size * ((prices[l.coin]?.mark ?? l.entry_px) - l.entry_px);
  }
  return pnl;
}

// Avaliação semanal. portfolioByAddress vem da coleta (curvas de 30 dias da Hyperliquid).
export function weeklyEvaluation(db, portfolioByAddress, now = Date.now(), { force = false } = {}) {
  const last = getState(db, 'last_eval') ?? 0;
  if (!force && now - last < PAPER.evalEveryDays * DAY) return null;
  const candidates = buildCandidates(db, portfolioByAddress, now)
    .filter((c) => c.sharpe > 0)
    .map((c) => ({ address: c.address, score: c.score, name: c.name }));
  const followers = db.prepare("SELECT * FROM paper_followers WHERE status != 'closed'").all();
  const actions = evaluate(candidates, followers);
  const { equity } = accountSummary(db, getState(db, 'last_prices'));
  const alloc = PAPER.allocFrac * equity;
  const pending = new Map(); // endereço -> posições atuais, preenchido no próximo ciclo para o baseline
  db.exec('BEGIN');
  try {
    for (const a of actions) {
      if (a.action === 'enter') {
        db.prepare(`INSERT INTO paper_followers (address, status, alloc, score, entered_at, misses, baseline)
          VALUES (?, 'active', ?, ?, ?, 0, NULL)
          ON CONFLICT(address) DO UPDATE SET status = 'active', alloc = excluded.alloc, score = excluded.score,
            entered_at = excluded.entered_at, misses = 0, baseline = NULL, runoff_at = NULL, runoff_pnl = NULL,
            exit_reason = NULL, closed_at = NULL`).run(a.address, alloc, a.score, now);
        pending.set(a.address, true);
      } else if (a.action === 'keep') {
        db.prepare('UPDATE paper_followers SET misses = 0, score = ?, alloc = ? WHERE address = ?').run(a.score, alloc, a.address);
      } else if (a.action === 'miss') {
        db.prepare('UPDATE paper_followers SET misses = misses + 1, alloc = ? WHERE address = ?').run(alloc, a.address);
      } else {
        db.prepare(`UPDATE paper_followers SET status = ?, exit_reason = ?, runoff_at = ?, runoff_pnl = NULL
          WHERE address = ?`).run(a.action === 'close' ? 'closing' : 'runoff', a.reason, now, a.address);
      }
    }
    db.prepare('INSERT OR REPLACE INTO paper_evaluations (ts, data) VALUES (?, ?)').run(now, JSON.stringify({
      equity, alloc, candidates: candidates.length, actions,
    }));
    setState(db, 'last_eval', now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const summary = actions.filter((a) => a.action !== 'keep').map((a) => `${a.action} ${a.address.slice(0, 8)}`).join(', ');
  console.log(`[paper] avaliação: ${candidates.length} candidatos; ${summary || 'sem mudanças'}`);
  return actions;
}

// Um ciclo: atualiza funding, busca posições dos traders seguidos e ajusta as posições copiadas.
export async function paperTick(db, { now = Date.now(), fetchState = (a) => info({ type: 'clearinghouseState', user: a }), prices } = {}) {
  prices ??= await getPrices();
  const followers = db.prepare("SELECT * FROM paper_followers WHERE status != 'closed'").all();
  const legs = loadLegs(db);
  let cash = getState(db, 'cash');

  // Funding desde o último ciclo (a taxa da Hyperliquid é por hora; long paga quando positiva).
  const lastTick = getState(db, 'last_tick') ?? now;
  const hours = Math.min((now - lastTick) / HOUR, 2);
  const updFunding = db.prepare('UPDATE paper_legs SET funding = funding + ? WHERE address = ? AND coin = ?');
  for (const [address, byCoin] of legs) {
    for (const l of Object.values(byCoin)) {
      const p = prices[l.coin];
      if (!l.size || !p) continue;
      const pay = -l.size * p.mark * p.funding * hours;
      l.funding += pay;
      cash += pay;
      updFunding.run(pay, address, l.coin);
    }
  }

  const equity = cash + [...legs.values()].flatMap(Object.values)
    .reduce((s, l) => s + (l.size ? l.size * ((prices[l.coin]?.mark ?? l.entry_px) - l.entry_px) : 0), 0);

  // Posições alvo de cada trader.
  const targets = {};
  const reasons = {};
  for (const f of followers) {
    const mine = Object.fromEntries(Object.values(legs.get(f.address) ?? {}).map((l) => [l.coin, l.size]));
    const runoffAge = f.runoff_at ? now - f.runoff_at : 0;
    if (f.status === 'closing' || (f.status === 'runoff' && runoffAge > PAPER.runoffDays * DAY)) {
      targets[f.address] = Object.fromEntries(Object.keys(mine).map((c) => [c, 0]));
      reasons[f.address] = f.status === 'closing' ? 'saída por risco' : 'fim do prazo de run-off';
      continue;
    }
    if (f.status === 'runoff') {
      const pnl = slicePnl(db, f.address, prices);
      if (f.runoff_pnl == null) db.prepare('UPDATE paper_followers SET runoff_pnl = ? WHERE address = ?').run(pnl, f.address);
      else if (pnl - f.runoff_pnl < -PAPER.runoffStop * f.alloc) {
        targets[f.address] = Object.fromEntries(Object.keys(mine).map((c) => [c, 0]));
        reasons[f.address] = 'stop do run-off';
        continue;
      }
    }
    let state;
    try {
      state = parsePositions(await fetchState(f.address));
    } catch (err) {
      console.error(`[paper] ${f.address}: ${err.message}`);
      continue; // sem dados: mantém o que tem
    }
    const positions = Object.fromEntries(state.positions.map((p) => [p.coin, p.size]));
    let baseline;
    if (f.baseline == null) {
      // Primeiro ciclo depois de entrar: grava o que ele já tinha aberto, que não será copiado.
      baseline = Object.fromEntries(Object.entries(positions).map(([c, s]) => [c, sign(s)]));
    } else baseline = JSON.parse(f.baseline);
    targets[f.address] = traderTargets({ status: f.status, alloc: f.alloc, accountValue: state.accountValue,
      positions, legs: mine, baseline, prices });
    db.prepare('UPDATE paper_followers SET baseline = ? WHERE address = ?').run(JSON.stringify(baseline), f.address);
    reasons[f.address] = f.status === 'runoff' ? 'run-off' : 'cópia';
  }
  applyCaps(targets, prices, equity);

  // Execução simulada.
  const upsertLeg = db.prepare(`INSERT INTO paper_legs (address, coin, size, entry_px, realized, fees)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(address, coin) DO UPDATE SET size = excluded.size,
    entry_px = excluded.entry_px, realized = realized + excluded.realized, fees = fees + excluded.fees`);
  const insertTrade = db.prepare(`INSERT INTO paper_trades (ts, address, coin, size, px, mid, fee, realized, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let trades = 0;
  db.exec('BEGIN');
  try {
    for (const [address, byCoin] of Object.entries(targets)) {
      for (const [coin, target] of Object.entries(byCoin)) {
        const p = prices[coin];
        const leg = legs.get(address)?.[coin];
        const current = leg?.size ?? 0;
        if (!p || !shouldTrade(current, target, p.mid)) continue;
        const delta = target - current;
        const px = fillPrice(p, delta);
        const r = applyFill({ size: current, entryPx: leg?.entry_px ?? null }, delta, px);
        cash += r.realized - r.fee;
        upsertLeg.run(address, coin, r.size, r.entryPx, r.realized, r.fee);
        insertTrade.run(now, address, coin, delta, px, p.mid, r.fee, r.realized, reasons[address]);
        trades++;
      }
    }
    // Quem está saindo e não tem mais nada aberto é encerrado.
    for (const f of followers) {
      if (f.status === 'active') continue;
      const open = db.prepare('SELECT COUNT(*) AS n FROM paper_legs WHERE address = ? AND size != 0').get(f.address).n;
      if (!open) db.prepare("UPDATE paper_followers SET status = 'closed', closed_at = ? WHERE address = ?").run(now, f.address);
    }
    setState(db, 'cash', cash);
    setState(db, 'last_tick', now);
    savePrices(db, prices);
    const s = accountSummary(db, prices);
    db.prepare('INSERT OR REPLACE INTO paper_equity (ts, equity, cash, gross, followers) VALUES (?, ?, ?, ?, ?)')
      .run(now, s.equity, s.cash, s.gross, followers.filter((f) => f.status === 'active').length);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (trades) console.log(`[paper] ${trades} ordens simuladas`);
  return { trades };
}

// ---------- leitura para o dashboard ----------

export function paperReport(db) {
  const prices = getState(db, 'last_prices') ?? null;
  // Curva com no máximo ~500 pontos.
  const all = db.prepare('SELECT ts, equity, gross FROM paper_equity ORDER BY ts').all();
  const step = Math.ceil(all.length / 500);
  const equity = all.filter((_, i) => i % step === 0 || i === all.length - 1);
  const followers = db.prepare(`SELECT f.*, t.display_name,
      (SELECT SUM(realized + funding - fees) FROM paper_legs l WHERE l.address = f.address) AS closed_pnl,
      (SELECT SUM(fees) FROM paper_legs l WHERE l.address = f.address) AS fees
    FROM paper_followers f LEFT JOIN traders t USING (address) ORDER BY f.status, f.entered_at`).all();
  return {
    config: PAPER, prices: prices && Object.fromEntries(Object.entries(prices).map(([c, p]) => [c, p.mark])), startedAt: getState(db, 'started_at'), lastEval: getState(db, 'last_eval'),
    account: accountSummary(db, prices), equity, followers,
    legs: db.prepare('SELECT * FROM paper_legs WHERE size != 0 ORDER BY address, coin').all(),
    trades: db.prepare('SELECT * FROM paper_trades ORDER BY ts DESC LIMIT 100').all(),
    evaluations: db.prepare('SELECT * FROM paper_evaluations ORDER BY ts DESC LIMIT 10').all()
      .map((e) => ({ ts: e.ts, ...JSON.parse(e.data) })),
  };
}

export function savePrices(db, prices) {
  setState(db, 'last_prices', Object.fromEntries(Object.entries(prices).map(([c, p]) => [c, { mark: p.mark }])));
}
