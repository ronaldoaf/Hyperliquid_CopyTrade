import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      ts INTEGER PRIMARY KEY, ok INTEGER NOT NULL, traders INTEGER, error TEXT
    );
    CREATE TABLE IF NOT EXISTS traders (
      address TEXT PRIMARY KEY, display_name TEXT, first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, in_group INTEGER NOT NULL DEFAULT 1, top_assets TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      ts INTEGER NOT NULL, address TEXT NOT NULL, copy_score REAL, account_value REAL,
      pnl_day REAL, pnl_week REAL, pnl_month REAL, pnl_all_time REAL,
      winrate REAL, sharpe REAL, drawdown REAL, total_trades INTEGER, open_positions INTEGER,
      PRIMARY KEY (address, ts)
    );
    CREATE TABLE IF NOT EXISTS positions (
      address TEXT NOT NULL, coin TEXT NOT NULL, size REAL, entry_px REAL, position_value REAL,
      unrealized_pnl REAL, leverage REAL, liquidation_px REAL, ts INTEGER NOT NULL,
      PRIMARY KEY (address, coin)
    );
  `);
  return db;
}
