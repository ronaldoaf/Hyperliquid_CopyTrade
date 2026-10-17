import { join } from 'node:path';
import { GROUPS, getGroupTraders } from './hyperdash.js';
import { getClearinghouseState, getPortfolio, getFillsSince, parsePositions, parsePortfolioPnl } from './hyperliquid.js';
import { appendRaw } from './archive.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// O SQLite não aceita undefined; campos ausentes na API viram NULL.
const bind = (...values) => values.map((v) => (v === undefined || Number.isNaN(v) ? null : v));
const FIRST_FILLS_WINDOW_MS = 30 * 24 * 3600_000;

export async function collect(db, { groupId, rawDir, traderDelayMs = 2500 }) {
  const ts = Date.now();
  try {
    // 1. Todos os grupos da página Copytrade, com todos os estilos.
    const groups = {};
    for (const g of GROUPS) {
      try {
        groups[g] = await getGroupTraders(g);
      } catch (err) {
        if (g === groupId) throw err;
        console.error(`[collector] grupo ${g}: ${err.message}`);
      }
    }
    appendRaw(rawDir, ts, Object.entries(groups).map(([group, data]) => ({ kind: 'hyperdash_group', group, data })));
    const insertMember = db.prepare(`
      INSERT OR REPLACE INTO group_members (ts, group_id, address, rank, tag, copy_score, copy_score_v1,
        pnl, perps_equity, winrate, sharpe, drawdown, total_trades, pnl_cohort, size_cohort, last_fill_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    for (const [g, list] of Object.entries(groups)) {
      [...list].sort((a, b) => (b.copyScore ?? -1) - (a.copyScore ?? -1)).forEach((t, i) => {
        insertMember.run(...bind(ts, g, t.address.toLowerCase(), i + 1, t.tag, t.copyScore, t.copyScoreV1,
          Number(t.pnl), Number(t.perpsEquity), t.winrate, t.sharpe, t.drawdown, t.totalTrades,
          t.pnlCohort, t.sizeCohort, t.lastFillAt, JSON.stringify(t)));
      });
    }
    db.exec('COMMIT');

    // 2. Detalhes na Hyperliquid de todos os traders do Top 100.
    const traders = groups[groupId];
    const upsertTrader = db.prepare(`
      INSERT INTO traders (address, display_name, first_seen, last_seen, in_group, top_assets, tag)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(address) DO UPDATE SET display_name = excluded.display_name,
        last_seen = excluded.last_seen, in_group = 1, top_assets = excluded.top_assets, tag = excluded.tag`);
    const insertSnap = db.prepare(`
      INSERT INTO snapshots (ts, address, copy_score, account_value, pnl_day, pnl_week, pnl_month,
        pnl_all_time, winrate, sharpe, drawdown, total_trades, open_positions, tag, perps_equity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const deletePos = db.prepare('DELETE FROM positions WHERE address = ?');
    const insertPos = db.prepare(`
      INSERT INTO positions (address, coin, size, entry_px, position_value, unrealized_pnl,
        leverage, liquidation_px, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertPosHist = db.prepare(`
      INSERT OR REPLACE INTO position_snapshots (ts, address, coin, size, entry_px, position_value,
        unrealized_pnl, leverage, liquidation_px) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFill = db.prepare(`
      INSERT OR IGNORE INTO fills (address, tid, time, coin, px, sz, side, dir, start_position,
        closed_pnl, fee, fee_token, crossed, oid, hash, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const getCursor = db.prepare('SELECT last_time FROM fill_cursor WHERE address = ?');
    const setCursor = db.prepare(`INSERT INTO fill_cursor (address, last_time) VALUES (?, ?)
      ON CONFLICT(address) DO UPDATE SET last_time = excluded.last_time`);

    let failures = 0, newFills = 0;
    for (const t of traders) {
      const address = t.address.toLowerCase();
      const since = getCursor.get(address)?.last_time ?? ts - FIRST_FILLS_WINDOW_MS;
      let state, portfolio, fills;
      try {
        [state, portfolio, fills] = await Promise.all([
          getClearinghouseState(address), getPortfolio(address), getFillsSince(address, since),
        ]);
      } catch (err) {
        failures++;
        console.error(`[collector] ${address}: ${err.message}`);
        await sleep(traderDelayMs);
        continue;
      }
      appendRaw(rawDir, ts, [
        { kind: 'clearinghouse_state', address, data: state },
        { kind: 'portfolio', address, data: portfolio },
      ]);
      const pos = parsePositions(state);
      const pnl = parsePortfolioPnl(portfolio);
      db.exec('BEGIN');
      try {
        upsertTrader.run(...bind(address, t.displayName, ts, ts, JSON.stringify(t.topAssets || []), t.tag));
        insertSnap.run(...bind(ts, address, t.copyScore, pos.accountValue, pnl.day, pnl.week, pnl.month,
          pnl.allTime, t.winrate, t.sharpe, t.drawdown, t.totalTrades, pos.positions.length, t.tag,
          Number(t.perpsEquity)));
        deletePos.run(address);
        for (const p of pos.positions) {
          const row = [address, p.coin, p.size, p.entryPx, p.positionValue, p.unrealizedPnl, p.leverage, p.liquidationPx];
          insertPos.run(...bind(...row, ts));
          insertPosHist.run(...bind(ts, ...row));
        }
        for (const f of fills) {
          newFills += Number(insertFill.run(...bind(address, f.tid, f.time, f.coin, Number(f.px), Number(f.sz),
            f.side, f.dir, Number(f.startPosition), Number(f.closedPnl), Number(f.fee), f.feeToken,
            f.crossed ? 1 : 0, f.oid, f.hash, JSON.stringify(f))).changes);
        }
        if (fills.length) setCursor.run(address, Math.max(...fills.map((f) => f.time)));
        else if (!getCursor.get(address)) setCursor.run(address, since);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      await sleep(traderDelayMs);
    }

    const current = traders.map((t) => t.address.toLowerCase());
    db.prepare(`UPDATE traders SET in_group = 0 WHERE address NOT IN (SELECT value FROM json_each(?))`)
      .run(JSON.stringify(current));
    db.prepare('INSERT INTO runs (ts, ok, traders, error) VALUES (?, 1, ?, ?)')
      .run(ts, traders.length, failures ? `${failures} carteiras falharam` : null);
    console.log(`[collector] ${traders.length} traders do ${groupId}, ${newFills} fills novos, ${failures} falhas, ${Math.round((Date.now() - ts) / 1000)}s`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    db.prepare('INSERT INTO runs (ts, ok, traders, error) VALUES (?, 0, 0, ?)').run(ts, err.message);
    console.error(`[collector] falhou: ${err.message}`);
  }
}
