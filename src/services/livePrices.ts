import { config } from '../config';
import { logger } from '../utils/logger';
import { broadcast } from '../socket/server';
import { getYahooPrice } from './yahoo';
import { resolveMarket, type Market } from './marketData';
import { getOpenTrades, computePnlPct } from './trades';
import { fmtPrice } from '../utils/price';
import { BinanceStream } from './binanceStream';

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export interface LivePosition {
  trade_id: number;
  symbol: string;
  side: string;
  market: Market;
  entry_price: number;
  entry_price_display: string;
  // null when the source has no quote yet (e.g. BIST outside trading hours, or a
  // transient fetch failure) — the position is still surfaced, just without P&L.
  current_price: number | null;
  current_price_display: string | null;
  pnl_pct: number | null;
  strategy: string | null;
}

// Latest live quote per symbol, fed continuously by the Binance WS (crypto) and
// the Yahoo poller (BIST). The flush loop reads from here — it never blocks on
// the network, so client updates stay on a steady ~1s cadence.
interface LiveQuote {
  price: number;
  at: string;
}
const live = new Map<string, LiveQuote>();

let stream: BinanceStream | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let bistTimer: NodeJS.Timeout | null = null;
let lastEmittedCount = 0;

function setQuote(symbol: string, price: number): void {
  live.set(symbol.toUpperCase(), { price, at: new Date().toISOString() });
}

/** Split currently-open trades into crypto vs BIST symbol lists (de-duped). */
function openSymbolsByMarket(): { crypto: string[]; bist: string[] } {
  const crypto = new Set<string>();
  const bist = new Set<string>();
  for (const t of getOpenTrades()) {
    const key = t.symbol.toUpperCase();
    (resolveMarket(key) === 'BIST' ? bist : crypto).add(key);
  }
  return { crypto: [...crypto], bist: [...bist] };
}

/** Poll Yahoo for the given BIST symbols and store their latest prices. */
async function pollBist(symbols: string[]): Promise<void> {
  await Promise.all(
    symbols.map(async (sym) => {
      const price = await getYahooPrice(sym);
      if (price !== null) setQuote(sym, price);
    })
  );
}

/**
 * Build the live-position payload from open trades + the latest-quote map and
 * push `price:update` (per quoted symbol) + a single `pnl:update`. Also reconciles
 * the Binance WS subscription set so it always tracks exactly the open crypto
 * symbols. Runs every LIVE_BROADCAST_INTERVAL_MS.
 */
function flush(): void {
  const open = getOpenTrades();
  const { crypto } = openSymbolsByMarket();

  // Keep the WS subscribed to exactly the open crypto symbols.
  stream?.setSymbols(crypto);

  // Drop cached quotes for symbols that are no longer open (bounded memory).
  const openKeys = new Set(open.map((t) => t.symbol.toUpperCase()));
  for (const key of live.keys()) if (!openKeys.has(key)) live.delete(key);

  if (open.length === 0) {
    if (lastEmittedCount !== 0) {
      broadcast('pnl:update', { at: new Date().toISOString(), positions: [], total_pnl_pct: 0 });
      lastEmittedCount = 0;
    }
    return;
  }

  const at = new Date().toISOString();
  for (const key of openKeys) {
    const q = live.get(key);
    if (q) broadcast('price:update', { symbol: key, price: q.price, price_display: fmtPrice(q.price), at });
  }

  const positions: LivePosition[] = open.map((t) => {
    const q = live.get(t.symbol.toUpperCase());
    const current = q ? q.price : null;
    return {
      trade_id: t.id,
      symbol: t.symbol,
      side: t.side,
      market: resolveMarket(t.symbol),
      entry_price: t.entry_price,
      entry_price_display: fmtPrice(t.entry_price),
      current_price: current,
      current_price_display: current === null ? null : fmtPrice(current),
      pnl_pct: current === null ? null : round(computePnlPct(t.side, t.entry_price, current)),
      strategy: t.strategy,
    };
  });
  lastEmittedCount = positions.length;

  broadcast('pnl:update', {
    at,
    positions,
    total_pnl_pct: round(positions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0)),
  });
}

/**
 * Start live pricing: a persistent Binance WebSocket for crypto (≈1s ticks), a
 * Yahoo poller for BIST every BIST_POLL_INTERVAL_MS, and a flush loop that
 * broadcasts a unified snapshot to dashboards every LIVE_BROADCAST_INTERVAL_MS.
 */
export function startLivePrices(): void {
  stream = new BinanceStream((symbol, price) => setQuote(symbol, price));

  const runBist = (): void => {
    const { bist } = openSymbolsByMarket();
    if (bist.length) {
      void pollBist(bist).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'BIST poll failed')
      );
    }
  };
  runBist(); // prime immediately so BIST shows fast
  bistTimer = setInterval(runBist, config.BIST_POLL_INTERVAL_MS);
  bistTimer.unref();

  flush(); // prime subscriptions + first snapshot
  flushTimer = setInterval(() => {
    try {
      flush();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Live flush failed');
    }
  }, config.LIVE_BROADCAST_INTERVAL_MS);
  flushTimer.unref();

  logger.info(
    {
      ws: config.BINANCE_WS_BASE,
      bist_ms: config.BIST_POLL_INTERVAL_MS,
      flush_ms: config.LIVE_BROADCAST_INTERVAL_MS,
    },
    'Live pricing started (Binance WS + BIST poll)'
  );
}

/** Stop all live-pricing timers and the WS (used on shutdown / tests). */
export function stopLivePrices(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (bistTimer) clearInterval(bistTimer);
  stream?.stop();
  flushTimer = bistTimer = null;
  stream = null;
  live.clear();
  lastEmittedCount = 0;
}
