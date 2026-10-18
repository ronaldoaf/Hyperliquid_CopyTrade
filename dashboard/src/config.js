const dataDir = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;

export const config = {
  port: Number(process.env.PORT || 8080),
  dataDir,
  dbPath: process.env.DB_PATH || `${dataDir}/dashboard.db`,
  rawDir: `${dataDir}/raw`,
  backupDir: `${dataDir}/backups`,
  intervalMinutes: Number(process.env.COLLECT_INTERVAL_MIN || 15),
  // Acima disso (média de ordens por dia nos últimos 7 dias), o trader é marcado como alta frequência. 0 desliga.
  maxOrdersPerDay: Number(process.env.MAX_ORDERS_PER_DAY || 20),
  traderDelayMs: Number(process.env.TRADER_DELAY_MS || 2500),
  groupId: process.env.HYPERDASH_GROUP || 'copytraders',
  tag: process.env.HYPERDASH_TAG || 'swing',
  dashUser: process.env.DASH_USER || 'admin',
  dashPassword: process.env.DASH_PASSWORD || '',
};
