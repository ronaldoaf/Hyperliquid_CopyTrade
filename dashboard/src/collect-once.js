import { config } from './config.js';
import { openDb } from './db.js';
import { collect } from './collector.js';

await collect(openDb(config.dbPath), config);
