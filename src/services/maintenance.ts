import { db } from '../db/connection';
import { config } from '../config';
import { logger } from '../utils/logger';

// FK cascade (PRAGMA foreign_keys = ON) removes the briefing's symbol rows and
// open-position snapshots. Trades are intentionally kept — they're the history.
const deleteOldBriefingsStmt = db.prepare('DELETE FROM briefings WHERE timestamp < ?');

/** Delete briefings older than the retention window. Returns rows removed. */
export function purgeOldBriefings(retentionDays: number = config.BRIEFING_RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const info = deleteOldBriefingsStmt.run(cutoff);
  if (info.changes > 0) {
    logger.info({ deleted: info.changes, cutoff }, 'Purged old briefings');
  }
  return info.changes;
}

/** Run a purge now and on a recurring interval. Timer is unref'd so it never keeps the process alive. */
export function startCleanupJob(): NodeJS.Timeout {
  try {
    purgeOldBriefings();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Initial briefing purge failed');
  }
  const timer = setInterval(() => {
    try {
      purgeOldBriefings();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Scheduled briefing purge failed');
    }
  }, config.CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
