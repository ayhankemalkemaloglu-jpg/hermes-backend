import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runMigrations } from './migrations';

// Ensure the parent directory of the DB file exists (e.g. /var/lib/hermes).
const dbDir = path.dirname(path.resolve(config.DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.DB_PATH);

// WAL mode: readers don't block the writer and vice versa — ideal for a server
// that writes occasionally (webhooks) while the API reads frequently.
db.pragma('journal_mode = WAL');
// Enforce REFERENCES ... ON DELETE CASCADE (off by default in SQLite).
db.pragma('foreign_keys = ON');
// NORMAL is the recommended durability/throughput tradeoff under WAL.
db.pragma('synchronous = NORMAL');

// Run migrations immediately so every module that imports `db` and prepares
// statements at load time finds the tables already present.
runMigrations(db);

logger.info({ dbPath: config.DB_PATH }, 'SQLite connected (WAL mode, migrations applied)');
