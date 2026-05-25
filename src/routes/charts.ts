import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { getKlines } from '../services/marketData';

const router = Router();

const ParamsSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9]{1,20}$/),
});

// Allowlist of timeframes mapped 1:1 to Binance kline intervals.
const QuerySchema = z.object({
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('1h'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

// GET /charts/:symbol?timeframe=1h&limit=200 → OHLCV candles for charting.
router.get('/:symbol', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  const params = ParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ ok: false, error: 'invalid_symbol' });
    return;
  }
  const q = QuerySchema.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ ok: false, error: 'invalid_query', details: q.error.flatten().fieldErrors });
    return;
  }

  const { timeframe, limit } = q.data;
  const candles = await getKlines(params.data.symbol, timeframe, limit);
  if (candles === null) {
    res.status(502).json({ ok: false, error: 'price_source_unavailable' });
    return;
  }

  res.json({
    ok: true,
    symbol: params.data.symbol.toUpperCase(),
    timeframe,
    count: candles.length,
    candles,
  });
});

export default router;
