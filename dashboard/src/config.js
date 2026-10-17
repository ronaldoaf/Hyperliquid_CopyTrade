export const config = {
  port: Number(process.env.PORT || 8080),
  dbPath: process.env.DB_PATH || new URL('../data/dashboard.db', import.meta.url).pathname,
  intervalMinutes: Number(process.env.COLLECT_INTERVAL_MIN || 15),
  groupId: process.env.HYPERDASH_GROUP || 'copytraders',
  tag: process.env.HYPERDASH_TAG || 'swing',
  dashUser: process.env.DASH_USER || 'admin',
  dashPassword: process.env.DASH_PASSWORD || '',
};
