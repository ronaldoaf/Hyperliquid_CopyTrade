import { getGroupTraders } from './hyperdash.js';
import { getPositions, getPortfolioPnl } from './hyperliquid.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function collect(db, { groupId, tag }) {
  const ts = Date.now();
  try {
    const all = await getGroupTraders(groupId);
    const traders = all.filter((t) => t.tag === tag);

    const upsertTrader = db.prepare(`
      INSERT INTO traders (address, display_name, first_seen, last_seen, in_group, top_assets)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(address) DO UPDATE SET display_name = excluded.display_name,
        last_seen = excluded.last_seen, in_group = 1, top_assets = excluded.top_assets`);
    const insertSnap = db.prepare(`
      INSERT INTO snapshots (ts, address, copy_score, account_value, pnl_day, pnl_week, pnl_month,
        pnl_all_time, winrate, sharpe, drawdown, total_trades, open_positions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const deletePos = db.prepare('DELETE FROM positions WHERE address = ?');
    const insertPos = db.prepare(`
      INSERT INTO positions (address, coin, size, entry_px, position_value, unrealized_pnl,
        leverage, liquidation_px, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let failures = 0;
    for (const t of traders) {
      const address = t.address.toLowerCase();
      let pos, pnl;
      try {
        [pos, pnl] = await Promise.all([getPositions(address), getPortfolioPnl(address)]);
      } catch (err) {
        failures++;
        console.error(`[collector] ${address}: ${err.message}`);
        continue;
      }
      db.exec('BEGIN');
      try {
        upsertTrader.run(address, t.displayName, ts, ts, JSON.stringify(t.topAssets || []));
        insertSnap.run(ts, address, t.copyScore, pos.accountValue, pnl.day, pnl.week, pnl.month,
          pnl.allTime, t.winrate, t.sharpe, t.drawdown, t.totalTrades, pos.positions.length);
        deletePos.run(address);
        for (const p of pos.positions) {
          insertPos.run(address, p.coin, p.size, p.entryPx, p.positionValue, p.unrealizedPnl,
            p.leverage, p.liquidationPx, ts);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      await sleep(300);
    }

    const current = traders.map((t) => t.address.toLowerCase());
    db.prepare(`UPDATE traders SET in_group = 0 WHERE address NOT IN (SELECT value FROM json_each(?))`)
      .run(JSON.stringify(current));
    db.prepare('INSERT INTO runs (ts, ok, traders, error) VALUES (?, 1, ?, ?)')
      .run(ts, traders.length, failures ? `${failures} carteiras falharam` : null);
    console.log(`[collector] ${traders.length} traders ${tag} de ${all.length} no grupo ${groupId}`);
  } catch (err) {
    db.prepare('INSERT INTO runs (ts, ok, traders, error) VALUES (?, 0, 0, ?)').run(ts, err.message);
    console.error(`[collector] falhou: ${err.message}`);
  }
}
