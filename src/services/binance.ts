import { config } from '../config';
import { logger } from '../utils/logger';

interface CacheEntry {
  price: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;
const TIMEOUT_MS = 5_000;

/**
 * Fetch the latest spot price for a symbol from Binance, with a 30s in-memory
 * cache and a 5s timeout. Returns null on any failure (network, timeout,
 * non-OK status, unparseable body) — the caller decides how to degrade.
 */
export async function getCurrentPrice(symbol: string): Promise<number | null> {
  const key = symbol.toUpperCase();
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.price;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${config.BINANCE_API_BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn({ symbol: key, status: res.status }, 'Binance price fetch returned non-OK');
      return null;
    }
    const data = (await res.json()) as { symbol?: string; price?: string };
    const price = data.price !== undefined ? parseFloat(data.price) : NaN;
    if (!Number.isFinite(price)) {
      logger.warn({ symbol: key, data }, 'Binance price unparseable');
      return null;
    }
    cache.set(key, { price, fetchedAt: now });
    return price;
  } catch (err) {
    logger.warn({ symbol: key, err: (err as Error).message }, 'Binance price fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
