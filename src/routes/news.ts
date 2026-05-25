import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { fetchNews } from '../services/news';

const router = Router();

const Query = z.object({
  category: z.string().optional(),
  count: z.coerce.number().int().min(1).max(30).default(15),
});

// GET /news?category=crypto — Brave API when configured, key-free RSS fallback.
router.get('/', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  const parsed = Query.safeParse(req.query);
  const category = (parsed.success ? parsed.data.category : undefined) ?? 'crypto';
  const count = parsed.success ? parsed.data.count : 15;

  const items = await fetchNews(category, count);
  res.json({ ok: true, category, count: items.length, items });
});

export default router;
