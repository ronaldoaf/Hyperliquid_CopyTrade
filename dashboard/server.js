import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { config } from './src/config.js';
import { openDb } from './src/db.js';
import { collect } from './src/collector.js';
import { dailyBackup } from './src/archive.js';
import { buildPortfolios, trackPortfolios } from './src/portfolios.js';
import { migrateScoreSamples, collectScoreSamples } from './src/score-samples.js';
import { PAPER, migratePaper, weeklyEvaluation, paperTick, paperReport } from './src/paper.js';

const db = openDb(config.dbPath);
migratePaper(db);
const indexHtml = new URL('./public/index.html', import.meta.url);

const queries = {
  traders: db.prepare(`
    WITH latest AS (
      SELECT s.* FROM snapshots s
      JOIN (SELECT address, MAX(ts) ts FROM snapshots GROUP BY address) m USING (address, ts)
    ), first AS (
      SELECT s.address, s.pnl_all_time FROM snapshots s
      JOIN (SELECT address, MIN(ts) ts FROM snapshots GROUP BY address) m USING (address, ts)
    )
    SELECT t.address, t.display_name, t.first_seen, t.in_group, t.top_assets,
      l.ts, l.copy_score, l.account_value, l.pnl_day, l.pnl_week, l.pnl_month, l.pnl_all_time,
      l.winrate, l.sharpe, l.drawdown, l.total_trades, l.open_positions,
      l.pnl_all_time - f.pnl_all_time AS pnl_tracked
    FROM traders t JOIN latest l USING (address) JOIN first f USING (address)
    WHERE t.tag = :tag AND t.high_freq = 0
    ORDER BY t.in_group DESC, l.copy_score DESC`),
  history: db.prepare(`SELECT ts, account_value, pnl_all_time, copy_score FROM snapshots
    WHERE address = ? ORDER BY ts`),
  positions: db.prepare(`SELECT coin, size, entry_px, position_value, unrealized_pnl, leverage,
    liquidation_px, ts FROM positions WHERE address = ? ORDER BY ABS(position_value) DESC`),
  // Soma, a cada coleta, do PnL acumulado desde que cada trader entrou no acompanhamento.
  // O MIN(ts) com GROUP BY faz o SQLite devolver o pnl_all_time da primeira linha de cada trader
  // numa só passada pelo índice, em vez de uma subconsulta por linha.
  summary: db.prepare(`
    WITH f AS (SELECT address, pnl_all_time AS base, MIN(ts) FROM snapshots GROUP BY address)
    SELECT s.ts, SUM(s.pnl_all_time - f.base) AS pnl_tracked, COUNT(*) AS traders
    FROM snapshots s JOIN f USING (address)
    WHERE s.tag = :tag AND s.address NOT IN (SELECT address FROM traders WHERE high_freq = 1)
    GROUP BY s.ts ORDER BY s.ts`),
  runs: db.prepare('SELECT ts, ok, traders, error FROM runs ORDER BY ts DESC LIMIT 20'),
  fillStats: db.prepare(`
    SELECT t.address, t.tag, t.in_group, t.high_freq,
      (SELECT COUNT(*) FROM fills f WHERE f.address = t.address AND f.time >= :since) AS fills_24h,
      (SELECT COUNT(DISTINCT oid) FROM fills f WHERE f.address = t.address AND f.time >= :since) AS orders_24h,
      (SELECT COUNT(DISTINCT oid) FROM fills f WHERE f.address = t.address AND f.time >= :week) AS orders_7d,
      (SELECT COUNT(*) FROM fills f WHERE f.address = t.address) AS fills_total
    FROM traders t ORDER BY orders_7d DESC`),
  counts: db.prepare(`SELECT
    (SELECT COUNT(*) FROM runs WHERE ok = 1) AS runs, (SELECT COUNT(*) FROM snapshots) AS snapshots,
    (SELECT COUNT(*) FROM position_snapshots) AS position_snapshots,
    (SELECT COUNT(*) FROM group_members) AS group_members, (SELECT COUNT(*) FROM fills) AS fills,
    (SELECT COUNT(*) FROM traders) AS traders`),
};

function authorized(req) {
  if (!config.dashPassword) return true;
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const given = Buffer.from(Buffer.from(value, 'base64').toString());
  const expected = Buffer.from(`${config.dashUser}:${config.dashPassword}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(req, res, body, type, status = 200) {
  const headers = { 'content-type': type, 'cache-control': 'no-cache' };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = gzipSync(body);
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(req, res, data, status = 200) {
  send(req, res, Buffer.from(JSON.stringify(data)), 'application/json; charset=utf-8', status);
}

// Os dados só mudam a cada coleta (ou a cada ciclo do paper trading), então as respostas ficam guardadas
// até lá. Assim o carregamento da página não refaz as consultas pesadas no SQLite, que travam o servidor.
const cache = new Map();
function cached(key, ttlMs, build) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = build();
  cache.set(key, { at: Date.now(), data });
  return data;
}
const clearCache = (prefix = '') => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };
const LONG = 30 * 60_000;

const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="dashboard"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  const traderMatch = url.pathname.match(/^\/api\/traders\/(0x[0-9a-fA-F]{40})$/);
  try {
    if (url.pathname === '/') {
      return send(req, res, await readFile(indexHtml), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/traders') return sendJson(req, res, cached('traders', LONG, () => queries.traders.all({ tag: config.tag })));
    if (traderMatch) {
      const address = traderMatch[1].toLowerCase();
      return sendJson(req, res, {
        history: queries.history.all(address),
        positions: queries.positions.all(address),
      });
    }
    if (url.pathname === '/api/fill-stats') {
      return sendJson(req, res, cached('fill-stats', LONG, () => ({ maxOrdersPerDay: config.maxOrdersPerDay,
        traders: queries.fillStats.all({ since: Date.now() - 24 * 3600_000, week: Date.now() - 7 * 24 * 3600_000 }) })));
    }
    if (url.pathname === '/api/portfolios') {
      return sendJson(req, res, cached('portfolios', LONG, () => trackPortfolios(db)));
    }
    if (url.pathname === '/api/paper') return sendJson(req, res, cached('paper', 60_000, () => paperReport(db)));
    if (url.pathname === '/api/summary') return sendJson(req, res, cached('summary', LONG, () => queries.summary.all({ tag: config.tag })));
    if (url.pathname === '/api/status') {
      return sendJson(req, res, cached('status', LONG, () => ({ config: { groupId: config.groupId, tag: config.tag,
        intervalMinutes: config.intervalMinutes }, stored: queries.counts.get(), runs: queries.runs.all() })));
    }
    // Cópia do banco para análise. Só existe com senha configurada, para não expor os dados.
    if (url.pathname === '/api/export.db' && config.dashPassword) {
      const file = `${config.dataDir}/export.db`;
      await rm(file, { force: true });
      db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
      res.writeHead(200, { 'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="copytrade-${new Date().toISOString().slice(0, 10)}.db"` });
      return createReadStream(file).pipe(res);
    }
    sendJson(req, res, { error: 'não encontrado' }, 404);
  } catch (err) {
    console.error(err);
    sendJson(req, res, { error: err.message }, 500);
  }
});

server.listen(config.port, () => console.log(`[server] ouvindo na porta ${config.port}`));

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await collect(db, config);
    // As carteiras são montadas uma única vez, com os dados da primeira coleta completa.
    const hasPortfolios = db.prepare('SELECT COUNT(*) AS n FROM portfolios').get().n > 0;
    if (result && !hasPortfolios) {
      try {
        buildPortfolios(db, result.portfolios, result.ts);
      } catch (err) {
        console.error(`[portfolios] ${err.message}`);
      }
    }
    if (result && config.paper) {
      try {
        weeklyEvaluation(db, result.portfolios, result.ts);
      } catch (err) {
        console.error(`[paper] avaliação: ${err.message}`);
      }
    }
    dailyBackup(db, config.backupDir);
    clearCache();
  } catch (err) {
    console.error(`[tick] ${err.message}`);
  } finally {
    running = false;
  }
}
tick();
setInterval(tick, config.intervalMinutes * 60_000);

// Paper trading: ciclo próprio, bem mais curto que a coleta, para copiar as mudanças de posição com pouco atraso.
let paperRunning = false;
async function paperLoop() {
  if (paperRunning || !config.paper) return;
  paperRunning = true;
  try {
    await paperTick(db);
    clearCache('paper');
  } catch (err) {
    console.error(`[paper] ${err.message}`);
  } finally {
    paperRunning = false;
  }
}
setInterval(paperLoop, PAPER.intervalSec * 1000);

// Amostra do copyScore: roda à parte da coleta de 15 min, uma vez por dia (leva algumas horas).
let sampling = false;
async function sampleTick() {
  if (sampling || !config.scoreSamples) return;
  sampling = true;
  try {
    await collectScoreSamples(db, { rawDir: config.rawDir, target: config.sampleTarget, delayMs: config.sampleDelayMs });
  } catch (err) {
    console.error(`[samples] ${err.message}`);
  } finally {
    sampling = false;
  }
}
migrateScoreSamples(db);
setTimeout(sampleTick, 60_000);
setInterval(sampleTick, 60 * 60_000);
