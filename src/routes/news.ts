import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { fetchNews } from '../services/news';

const router = Router();

// Map a category to a search query; an explicit ?q= overrides it.
const CATEGORY_QUERY: Record<string, string> = {
  crypto: 'cryptocurrency bitcoin ethereum market',
  stocks: 'stock market nasdaq earnings',
  turkey: 'borsa istanbul türkiye ekonomi',
};

const Query = z.object({
  category: z.string().optional(),
  q: z.string().min(1).max(120).optional(),
  count: z.coerce.number().int().min(1).max(30).default(15),
});

router.get('/', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  if (!config.BRAVE_API_KEY) {
    res.status(503).json({ ok: false, error: 'news_not_configured' });
    return;
  }

  const parsed = Query.safeParse(req.query);
  const category = parsed.success ? parsed.data.category : undefined;
  const q = parsed.success ? parsed.data.q : undefined;
  const count = parsed.success ? parsed.data.count : 15;
  const query = q ?? CATEGORY_QUERY[category ?? 'crypto'] ?? CATEGORY_QUERY.crypto;

  const items = await fetchNews(query, count);
  if (items === null) {
    res.status(502).json({ ok: false, error: 'news_source_unavailable' });
    return;
  }

  res.json({ ok: true, query, count: items.length, items });
});

export default router;
