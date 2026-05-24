import { Router, Request, Response } from 'express';
import { db } from '../db/connection';
import { getLatestBriefing } from '../services/briefings';

const router = Router();
const startedAt = Date.now();
const VERSION = process.env.npm_package_version ?? '1.0.0';

// No auth: this endpoint is for load balancers / uptime checks.
router.get('/', (_req: Request, res: Response) => {
  let dbOk = false;
  let lastBriefingAt: string | null = null;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
    lastBriefingAt = getLatestBriefing()?.timestamp ?? null;
  } catch {
    dbOk = false;
  }

  res.json({
    ok: dbOk,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    db_ok: dbOk,
    last_briefing_at: lastBriefingAt,
    version: VERSION,
  });
});

export default router;
