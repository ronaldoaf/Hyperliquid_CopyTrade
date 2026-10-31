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
  // Amostra diária para a engenharia reversa do copyScore (docs/copyscore.md). SCORE_SAMPLES=0 desliga.
  scoreSamples: process.env.SCORE_SAMPLES !== '0',
  sampleTarget: Number(process.env.SAMPLE_TARGET || 8000),
  sampleDelayMs: Number(process.env.SAMPLE_DELAY_MS || 1000),
  // Paper trading de copytrading (src/paper.js). PAPER=0 desliga; parâmetros em PAPER_* (veja src/paper.js).
  paper: process.env.PAPER !== '0',
  dashUser: process.env.DASH_USER || 'admin',
  dashPassword: process.env.DASH_PASSWORD || '',
};
