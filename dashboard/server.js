import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { config } from './src/config.js';
import { openDb } from './src/db.js';
import { collect } from './src/collector.js';
import { dailyBackup } from './src/archive.js';

const db = openDb(config.dbPath);
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
    WHERE t.tag = :tag
    ORDER BY t.in_group DESC, l.copy_score DESC`),
  history: db.prepare(`SELECT ts, account_value, pnl_all_time, copy_score FROM snapshots
    WHERE address = ? ORDER BY ts`),
  positions: db.prepare(`SELECT coin, size, entry_px, position_value, unrealized_pnl, leverage,
    liquidation_px, ts FROM positions WHERE address = ? ORDER BY ABS(position_value) DESC`),
  // Soma, a cada coleta, do PnL acumulado desde que cada trader entrou no acompanhamento.
  summary: db.prepare(`
    SELECT s.ts, SUM(s.pnl_all_time - f.base) AS pnl_tracked, COUNT(*) AS traders
    FROM snapshots s
    JOIN (SELECT address, pnl_all_time AS base FROM snapshots s2
          WHERE ts = (SELECT MIN(ts) FROM snapshots WHERE address = s2.address)) f USING (address)
    WHERE s.tag = :tag
    GROUP BY s.ts ORDER BY s.ts`),
  runs: db.prepare('SELECT ts, ok, traders, error FROM runs ORDER BY ts DESC LIMIT 20'),
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

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="dashboard"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  const traderMatch = url.pathname.match(/^\/api\/traders\/(0x[0-9a-fA-F]{40})$/);
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(indexHtml));
    }
    if (url.pathname === '/api/traders') return sendJson(res, queries.traders.all({ tag: config.tag }));
    if (traderMatch) {
      const address = traderMatch[1].toLowerCase();
      return sendJson(res, {
        history: queries.history.all(address),
        positions: queries.positions.all(address),
      });
    }
    if (url.pathname === '/api/summary') return sendJson(res, queries.summary.all({ tag: config.tag }));
    if (url.pathname === '/api/status') {
      return sendJson(res, { config: { groupId: config.groupId, tag: config.tag,
        intervalMinutes: config.intervalMinutes }, stored: queries.counts.get(), runs: queries.runs.all() });
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
    sendJson(res, { error: 'não encontrado' }, 404);
  } catch (err) {
    console.error(err);
    sendJson(res, { error: err.message }, 500);
  }
});

server.listen(config.port, () => console.log(`[server] ouvindo na porta ${config.port}`));

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await collect(db, config);
    dailyBackup(db, config.backupDir);
  } catch (err) {
    console.error(`[tick] ${err.message}`);
  } finally {
    running = false;
  }
}
tick();
setInterval(tick, config.intervalMinutes * 60_000);
