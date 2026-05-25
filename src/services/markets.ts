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

/** Fetch a single Yahoo Finance quote (price + day change %). Null on failure. */
async function fetchYahoo(symbol: string): Promise<Quote | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal,
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
    clearTimeout(timer);
  }
}

/**
 * Türkiye snapshot: BIST 100 (XU100.IS), USD/TRY (TRY=X) and gram gold in TRY
 * (derived: gold oz USD / 31.1035 × USD/TRY). Cached 30s. Key-free (Yahoo).
 */
export async function getTurkeyMarkets(): Promise<TurkeyMarkets> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const [bist, usdtry, goldOz] = await Promise.all([
    fetchYahoo('XU100.IS'),
    fetchYahoo('TRY=X'),
    fetchYahoo('GC=F'),
  ]);

  let goldGram: Quote | null = null;
  if (goldOz && usdtry) {
    goldGram = {
      symbol: 'GOLD_GRAM_TRY',
      price: (goldOz.price / OZ_TO_GRAM) * usdtry.price,
      changePct: goldOz.changePct, // gram tracks the oz move (FX change is small intraday)
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
