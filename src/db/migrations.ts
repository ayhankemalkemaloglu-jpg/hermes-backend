import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';

/**
 * Locate schema.sql at runtime. Works both under tsx (src/db) and after a
 * `tsc` build (dist/db) — the .sql file is not emitted by tsc, so we fall back
 * to the source tree, which is always present in a cloned repo.
 */
function resolveSchemaPath(): string {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'src', 'db', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`schema.sql not found. Looked in:\n  ${candidates.join('\n  ')}`);
}

/**
 * Apply the schema. CREATE TABLE IF NOT EXISTS makes this idempotent, so it is
 * safe to run on every startup.
 */
export function runMigrations(db: Database.Database): void {
  const schemaPath = resolveSchemaPath();
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(sql);
  logger.info({ schemaPath }, 'Database migrations applied');
}
