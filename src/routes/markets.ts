import { Router, Request, Response } from 'express';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { getTurkeyMarkets } from '../services/markets';

const router = Router();

// GET /markets/turkey — BIST 100, USD/TRY, gram gold (TRY). Key-free (Yahoo).
router.get('/turkey', requireAuth(config.AUTH_TOKEN), async (_req: Request, res: Response) => {
  const data = await getTurkeyMarkets();
  res.json({ ok: true, ...data });
});

export default router;
