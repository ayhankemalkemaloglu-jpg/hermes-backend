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

interface YahooMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
}
interface YahooResp {
  chart?: { result?: Array<{ meta?: YahooMeta }> };
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 6_000;
const TTL_MS = 30_000;
const OZ_TO_GRAM = 31.1034768;

let cache: { data: TurkeyMarkets; at: number } | null = null;

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/** Yahoo Finance quote (price + day change %). Symbol passed literally (no
 *  percent-encoding — Yahoo wants `GC=F`, not `GC%3DF`). Null on failure. */
async function fetchYahoo(symbol: string): Promise<Quote | null> {
  const { signal, done } = withTimeout();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      logger.warn({ symbol, status: res.status }, 'Yahoo quote returned non-OK');
      return null;
    }
    const data = (await res.json()) as YahooResp;
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
    const price = meta.regularMarketPrice;
    const prev =
      typeof meta.chartPreviousClose === 'number'
        ? meta.chartPreviousClose
        : typeof meta.previousClose === 'number'
          ? meta.previousClose
          : null;
    const changePct = prev && prev !== 0 ? ((price - prev) / prev) * 100 : null;
    return { symbol, price, changePct };
  } catch (err) {
    logger.warn({ symbol, err: (err as Error).message }, 'Yahoo quote failed');
    return null;
  } finally {
    done();
  }
}

/** USD/TRY from open.er-api.com (free, no key, not rate-limited like Yahoo FX). */
async function fetchUsdTry(): Promise<Quote | null> {
  const { signal, done } = withTimeout();
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'er-api USD/TRY non-OK');
      return null;
    }
    const data = (await res.json()) as { rates?: { TRY?: number } };
    const rate = data.rates?.TRY;
    if (typeof rate !== 'number') return null;
    return { symbol: 'USDTRY', price: rate, changePct: null };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'er-api USD/TRY failed');
    return null;
  } finally {
    done();
  }
}

/**
 * Türkiye snapshot (key-free): BIST 100 (Yahoo XU100.IS), USD/TRY (er-api),
 * gram gold in TRY (Yahoo GC=F oz USD / 31.1035 × USD/TRY). Yahoo calls are
 * sequential to avoid the burst rate-limit (429) seen on its FX endpoint.
 * Cached 30s.
 */
export async function getTurkeyMarkets(): Promise<TurkeyMarkets> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const usdtry = await fetchUsdTry();
  const bist = await fetchYahoo('XU100.IS');
  const goldOz = await fetchYahoo('GC=F');

  let goldGram: Quote | null = null;
  if (goldOz && usdtry) {
    goldGram = {
      symbol: 'GOLD_GRAM_TRY',
      price: (goldOz.price / OZ_TO_GRAM) * usdtry.price,
      changePct: goldOz.changePct,
    };
  }

  const data: TurkeyMarkets = {
    bist100: bist,
    usdtry,
    gold_gram_try: goldGram,
    at: new Date().toISOString(),
  };
  cache = { data, at: now };
  return data;
}
