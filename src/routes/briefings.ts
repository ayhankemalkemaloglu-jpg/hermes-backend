import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { getRecentBriefings } from '../services/briefings';

const router = Router();

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(168).default(24),
});

router.get('/', requireAuth(config.AUTH_TOKEN), (req: Request, res: Response) => {
  const q = QuerySchema.safeParse(req.query);
  const limit = q.success ? q.data.limit : 24;
  const briefings = getRecentBriefings(limit);
  res.json({ ok: true, count: briefings.length, briefings });
});

export default router;
