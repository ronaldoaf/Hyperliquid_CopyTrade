import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function addColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      ts INTEGER PRIMARY KEY, ok INTEGER NOT NULL, traders INTEGER, error TEXT
    );
    -- Traders do Top 100 acompanhados em detalhe (todos os estilos; o dashboard filtra pelo tag).
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
    -- Posições abertas mais recentes (o dashboard usa esta).
    CREATE TABLE IF NOT EXISTS positions (
      address TEXT NOT NULL, coin TEXT NOT NULL, size REAL, entry_px REAL, position_value REAL,
      unrealized_pnl REAL, leverage REAL, liquidation_px REAL, ts INTEGER NOT NULL,
      PRIMARY KEY (address, coin)
    );
    -- Histórico das posições a cada coleta.
    CREATE TABLE IF NOT EXISTS position_snapshots (
      ts INTEGER NOT NULL, address TEXT NOT NULL, coin TEXT NOT NULL, size REAL, entry_px REAL,
      position_value REAL, unrealized_pnl REAL, leverage REAL, liquidation_px REAL,
      PRIMARY KEY (address, ts, coin)
    );
    -- Composição de cada grupo da Hyperdash a cada coleta, com a posição no ranking.
    CREATE TABLE IF NOT EXISTS group_members (
      ts INTEGER NOT NULL, group_id TEXT NOT NULL, address TEXT NOT NULL, rank INTEGER,
      tag TEXT, copy_score REAL, copy_score_v1 REAL, pnl REAL, perps_equity REAL, winrate REAL,
      sharpe REAL, drawdown REAL, total_trades INTEGER, pnl_cohort TEXT, size_cohort TEXT,
      last_fill_at INTEGER, data TEXT,
      PRIMARY KEY (group_id, address, ts)
    );
    -- Execuções (fills) de cada trader acompanhado, sem duplicar.
    CREATE TABLE IF NOT EXISTS fills (
      address TEXT NOT NULL, tid INTEGER NOT NULL, time INTEGER NOT NULL, coin TEXT, px REAL,
      sz REAL, side TEXT, dir TEXT, start_position REAL, closed_pnl REAL, fee REAL,
      fee_token TEXT, crossed INTEGER, oid INTEGER, hash TEXT, raw TEXT,
      PRIMARY KEY (address, tid)
    );
    CREATE INDEX IF NOT EXISTS fills_time ON fills (address, time);
    CREATE TABLE IF NOT EXISTS fill_cursor (address TEXT PRIMARY KEY, last_time INTEGER NOT NULL);
  `);
  addColumn(db, 'traders', 'tag', 'TEXT');
  addColumn(db, 'snapshots', 'tag', 'TEXT');
  addColumn(db, 'snapshots', 'perps_equity', 'REAL');
  // 1 = opera demais para ser copiado: fica fora do dashboard e as execuções deixam de ser coletadas.
  addColumn(db, 'traders', 'high_freq', 'INTEGER NOT NULL DEFAULT 0');
  // Antes desta versão só os traders swing eram gravados.
  db.exec(`UPDATE traders SET tag = 'swing' WHERE tag IS NULL;
           UPDATE snapshots SET tag = 'swing' WHERE tag IS NULL;`);
  return db;
}
