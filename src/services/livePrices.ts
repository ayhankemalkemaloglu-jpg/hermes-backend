import { config } from '../config';
import { logger } from '../utils/logger';
import { broadcast } from '../socket/server';
import { getCurrentPrice, resolveMarket, type Market } from './marketData';
import { getOpenTrades, computePnlPct } from './trades';
import { fmtPrice } from '../utils/price';

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

/**
 * Fetch current prices for every open-position symbol (crypto via Binance, BIST
 * via Yahoo), broadcast a `price:update` per resolved symbol, then compute
 * unrealized P&L per open trade and broadcast a single `pnl:update`. Symbols
 * whose source has no quote (e.g. BIST outside trading hours) are still included
 * in the payload with a null price/P&L, so the dashboard never silently drops a
 * position — it just shows "—" until a quote arrives.
 */
export async function tickPrices(): Promise<void> {
  const open = getOpenTrades();
  if (open.length === 0) return;

  const symbols = [...new Set(open.map((t) => t.symbol))];
  const prices = new Map<string, number>();
  await Promise.all(
    symbols.map(async (symbol) => {
      const price = await getCurrentPrice(symbol);
      if (price !== null) prices.set(symbol, price);
    })
  );

  const at = new Date().toISOString();
  for (const [symbol, price] of prices) {
    broadcast('price:update', { symbol, price, price_display: fmtPrice(price), at });
  }

  const positions: LivePosition[] = open.map((t) => {
    const current = prices.has(t.symbol) ? (prices.get(t.symbol) as number) : null;
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

  broadcast('pnl:update', {
    at,
    positions,
    total_pnl_pct: round(
      positions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0)
    ),
  });
}

/** Start the recurring poller. Timer is unref'd so it never keeps the process alive. */
export function startPricePoller(): NodeJS.Timeout {
  const run = (): void => {
    void tickPrices().catch((err) =>
      logger.warn({ err: (err as Error).message }, 'Price tick failed')
    );
  };
  run();
  const timer = setInterval(run, config.PRICE_POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}
