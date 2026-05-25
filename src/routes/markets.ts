import { Router, Request, Response } from 'express';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { fetchTurkeyMarkets } from '../services/turkey';

const router = Router();

// GET /markets/turkey — BIST 100, USD/TRY, gram gold (TRY). Yahoo-backed, cached.
router.get('/turkey', requireAuth(config.AUTH_TOKEN), async (_req: Request, res: Response) => {
  const data = await fetchTurkeyMarkets();
  res.json(data);
});

export default router;
