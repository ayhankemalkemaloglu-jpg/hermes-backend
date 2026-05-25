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

/** Generic JSON GET with timeout, returns parsed body or null. */
async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'markets fallback returned non-OK');
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn({ url, err: (err as Error).message }, 'markets fallback failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Key-free USD/TRY fallback (open.er-api.com) — price only, no prev close. */
async function fetchUsdTryFallback(): Promise<YahooQuote | null> {
  const data = (await fetchJson('https://open.er-api.com/v6/latest/USD')) as
    | { rates?: { TRY?: number } }
    | null;
  const try_ = data?.rates?.TRY;
  return typeof try_ === 'number' && Number.isFinite(try_) ? { price: try_, prevClose: null } : null;
}

/** Key-free gold (USD per troy ounce) fallback: gold-api.com, then goldprice.org. */
async function fetchGoldOzFallback(): Promise<number | null> {
  const a = (await fetchJson('https://api.gold-api.com/price/XAU')) as { price?: number } | null;
  if (a && typeof a.price === 'number' && Number.isFinite(a.price)) return a.price;
  const b = (await fetchJson('https://data-asg.goldprice.org/dbXRates/USD')) as
    | { items?: Array<{ xauPrice?: number }> }
    | null;
  const xau = b?.items?.[0]?.xauPrice;
  return typeof xau === 'number' && Number.isFinite(xau) ? xau : null;
}

/**
 * Türkiye markets for the dashboard's Türkiye layer: BIST 100, USD/TRY and gram
 * gold (TRY). Yahoo Finance is primary (full data incl. change%); when Yahoo is
 * blocked, USD/TRY falls back to open.er-api.com and gold to gold-api.com so the
 * tickers still populate (without a change% on the fallback path). Cached 60s.
 */
export async function fetchTurkeyMarkets(): Promise<TurkeyMarkets> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.data;

  const bist = await fetchYahoo('XU100.IS');

  let usd = await fetchYahoo('USDTRY=X');
  if (!usd) usd = await fetchUsdTryFallback();

  // Gold per troy ounce (USD): Yahoo GC=F, else the key-free fallback.
  let goldOzPrice: number | null = null;
  let goldOzPrev: number | null = null;
  const gc = await fetchYahoo('GC=F');
  if (gc) {
    goldOzPrice = gc.price;
    goldOzPrev = gc.prevClose;
  } else {
    goldOzPrice = await fetchGoldOzFallback();
  }

  const bist100: Quote | null = bist
    ? { symbol: 'XU100', price: round(bist.price, 2), changePct: changePct(bist.price, bist.prevClose) }
    : null;

  const usdtry: Quote | null = usd
    ? { symbol: 'USDTRY', price: round(usd.price, 4), changePct: changePct(usd.price, usd.prevClose) }
    : null;

  let gold_gram_try: Quote | null = null;
  if (goldOzPrice !== null && usd) {
    const gramNow = (goldOzPrice / TROY_OZ_G) * usd.price;
    let pct: number | null = null;
    if (goldOzPrev !== null && usd.prevClose !== null && usd.prevClose !== 0) {
      const gramPrev = (goldOzPrev / TROY_OZ_G) * usd.prevClose;
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
