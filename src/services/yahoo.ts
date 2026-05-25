import { config } from '../config';
import { logger } from '../utils/logger';
import type { Candle } from './binance';

/**
 * Yahoo Finance price + OHLC source for Borsa İstanbul (BIST) equities. BIST
 * tickers are addressed with the `.IS` suffix (e.g. `THYAO` → `THYAO.IS`).
 *
 * Uses the public `v8/finance/chart` endpoint, which returns both a `meta`
 * block (with `regularMarketPrice`) and the OHLC arrays — so one shape serves
 * both the spot-price and the klines needs. No API key required. Every failure
 * resolves to null so callers degrade exactly as they do for Binance.
 */

const TTL_MS = 30_000;
const TIMEOUT_MS = 5_000;

interface CacheEntry {
  price: number;
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Append the BIST market suffix unless the caller already provided one. */
function toYahooSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  return s.includes('.') ? s : `${s}.IS`;
}

// App timeframe -> Yahoo (interval, range). Yahoo has no 4h candle, so it maps
// to 60m over a wider range; the caller slices down to the requested limit.
const TIMEFRAME_MAP: Record<string, { interval: string; range: string }> = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '1h': { interval: '60m', range: '1mo' },
  '4h': { interval: '60m', range: '3mo' },
  '1d': { interval: '1d', range: '1y' },
};

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: unknown;
  };
}

async function fetchChart(
  yahooSymbol: string,
  interval: string,
  range: string
): Promise<YahooChart | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `${config.YAHOO_API_BASE}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
      `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      // Yahoo rejects requests without a browser-like UA.
      headers: { 'User-Agent': 'Mozilla/5.0 (HermesCommandCenter)' },
    });
    if (!res.ok) {
      logger.warn({ symbol: yahooSymbol, status: res.status }, 'Yahoo chart returned non-OK');
      return null;
    }
    return (await res.json()) as YahooChart;
  } catch (err) {
    logger.warn({ symbol: yahooSymbol, err: (err as Error).message }, 'Yahoo chart fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Latest price for a BIST equity (30s cache, 5s timeout). null on any failure. */
export async function getYahooPrice(symbol: string): Promise<number | null> {
  const key = symbol.toUpperCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.price;

  const data = await fetchChart(toYahooSymbol(symbol), '1d', '1d');
  const result = data?.chart?.result?.[0];
  let price = result?.meta?.regularMarketPrice;

  // Fall back to the last non-null close if meta has no live price.
  if (!Number.isFinite(price as number)) {
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (typeof c === 'number' && Number.isFinite(c)) {
        price = c;
        break;
      }
    }
  }

  if (!Number.isFinite(price as number)) {
    logger.warn({ symbol: key }, 'Yahoo price unparseable');
    return null;
  }
  cache.set(key, { price: price as number, fetchedAt: now });
  return price as number;
}

/** OHLC candles for a BIST equity, shaped like Binance klines. null on failure. */
export async function getYahooKlines(
  symbol: string,
  timeframe: string,
  limit: number
): Promise<Candle[] | null> {
  const mapped = TIMEFRAME_MAP[timeframe] ?? TIMEFRAME_MAP['1d'];
  const data = await fetchChart(toYahooSymbol(symbol), mapped.interval, mapped.range);
  const result = data?.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts || !q) {
    logger.warn({ symbol: symbol.toUpperCase(), timeframe }, 'Yahoo klines unexpected shape');
    return null;
  }

  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    // Yahoo emits null entries for gaps (market closed); skip incomplete rows.
    if (![o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    candles.push({
      time: ts[i],
      open: o as number,
      high: h as number,
      low: l as number,
      close: c as number,
      volume: typeof q.volume?.[i] === 'number' ? (q.volume[i] as number) : 0,
    });
  }
  // Keep only the most recent `limit` candles, matching the Binance limit semantics.
  return candles.slice(-limit);
}
