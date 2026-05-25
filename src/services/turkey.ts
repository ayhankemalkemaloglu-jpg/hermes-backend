import { logger } from '../utils/logger';

export interface Quote {
  symbol: string;
  price: number;
  changePct: number | null;
}

export interface TurkeyMarkets {
  bist100: Quote | null;
  usdtry: Quote | null;
  gold_gram_try: Quote | null;
  at: string;
}

// Browser-like UA so Yahoo doesn't 403 the request.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 6_000;
const TTL_MS = 60_000;
const TROY_OZ_G = 31.1034768; // grams per troy ounce (gram gold = oz price / this)

interface CacheEntry {
  data: TurkeyMarkets;
  fetchedAt: number;
}
let cache: CacheEntry | null = null;

interface YahooQuote {
  price: number;
  prevClose: number | null;
}

// query1 is primary; query2 is the failover host (Yahoo rotates load/limits).
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

async function fetchFromHost(host: string, symbol: string): Promise<YahooQuote | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ symbol, host, status: res.status }, 'Yahoo quote returned non-OK');
      return null;
    }
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
          };
        }>;
      };
    };
    const meta = data.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number' || !Number.isFinite(price)) return null;
    const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
    return { price, prevClose: typeof prev === 'number' && Number.isFinite(prev) ? prev : null };
  } catch (err) {
    logger.warn({ symbol, host, err: (err as Error).message }, 'Yahoo quote fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Latest price + previous close for a Yahoo symbol, trying both hosts. */
async function fetchYahoo(symbol: string): Promise<YahooQuote | null> {
  for (const host of YAHOO_HOSTS) {
    const quote = await fetchFromHost(host, symbol);
    if (quote) return quote;
  }
  return null;
}

function changePct(price: number, prev: number | null): number | null {
  if (prev === null || prev === 0) return null;
  return Math.round(((price - prev) / prev) * 10000) / 100;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Türkiye markets for the dashboard's Türkiye layer: BIST 100 (XU100.IS),
 * USD/TRY (USDTRY=X) and gram gold in TRY (derived from COMEX gold GC=F and
 * USD/TRY). Cached 60s. Yahoo Finance, no API key. Fields that fail resolve to
 * null so the dashboard shows what it can.
 */
export async function fetchTurkeyMarkets(): Promise<TurkeyMarkets> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.data;

  const [bist, usd, gold] = await Promise.all([
    fetchYahoo('XU100.IS'),
    fetchYahoo('USDTRY=X'),
    fetchYahoo('GC=F'),
  ]);

  const bist100: Quote | null = bist
    ? { symbol: 'XU100', price: round(bist.price, 2), changePct: changePct(bist.price, bist.prevClose) }
    : null;

  const usdtry: Quote | null = usd
    ? { symbol: 'USDTRY', price: round(usd.price, 4), changePct: changePct(usd.price, usd.prevClose) }
    : null;

  let gold_gram_try: Quote | null = null;
  if (gold && usd) {
    const gramNow = (gold.price / TROY_OZ_G) * usd.price;
    let pct: number | null = null;
    if (gold.prevClose !== null && usd.prevClose !== null && usd.prevClose !== 0) {
      const gramPrev = (gold.prevClose / TROY_OZ_G) * usd.prevClose;
      pct = changePct(gramNow, gramPrev);
    }
    gold_gram_try = { symbol: 'GRAM', price: round(gramNow, 2), changePct: pct };
  }

  const data: TurkeyMarkets = {
    bist100,
    usdtry,
    gold_gram_try,
    at: new Date().toISOString(),
  };
  // Cache only a partially-good result; a total failure retries on the next call.
  if (bist100 || usdtry || gold_gram_try) cache = { data, fetchedAt: now };
  return data;
}
