import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { getTrades, getStats, StatsWindow, withPriceDisplay } from '../services/trades';

const router = Router();

const ListQuery = z.object({
  status: z.string().optional(),
  symbol: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

router.get('/', requireAuth(config.AUTH_TOKEN), (req: Request, res: Response) => {
  const q = ListQuery.safeParse(req.query);
  const filters = q.success ? q.data : { limit: 100 };
  const trades = getTrades(filters).map(withPriceDisplay);
  res.json({ ok: true, count: trades.length, trades });
});

const StatsQuery = z.object({
  window: z.enum(['24h', '7d', '30d', 'all']).default('24h'),
});

router.get('/stats', requireAuth(config.AUTH_TOKEN), (req: Request, res: Response) => {
  const q = StatsQuery.safeParse(req.query);
  const window: StatsWindow = q.success ? q.data.window : '24h';
  res.json({ ok: true, stats: getStats(window) });
});

export default router;
