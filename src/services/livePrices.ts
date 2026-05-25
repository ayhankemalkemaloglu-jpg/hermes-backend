import { config } from '../config';
import { logger } from '../utils/logger';
import { broadcast } from '../socket/server';
import { getCurrentPrice } from './binance';
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
  entry_price: number;
  entry_price_display: string;
  current_price: number;
  current_price_display: string;
  pnl_pct: number;
  strategy: string | null;
}

/**
 * Fetch current prices for every open-position symbol, broadcast a `price:update`
 * per symbol, then compute unrealized P&L per open trade and broadcast a single
 * `pnl:update`. Symbols Binance doesn't know (e.g. stocks) resolve to null and
 * are simply skipped — the dashboard shows what it can.
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

  const positions: LivePosition[] = open
    .filter((t) => prices.has(t.symbol))
    .map((t) => {
      const current = prices.get(t.symbol) as number;
      return {
        trade_id: t.id,
        symbol: t.symbol,
        side: t.side,
        entry_price: t.entry_price,
        entry_price_display: fmtPrice(t.entry_price),
        current_price: current,
        current_price_display: fmtPrice(current),
        pnl_pct: round(computePnlPct(t.side, t.entry_price, current)),
        strategy: t.strategy,
      };
    });

  if (positions.length > 0) {
    broadcast('pnl:update', {
      at,
      positions,
      total_pnl_pct: round(positions.reduce((s, p) => s + p.pnl_pct, 0)),
    });
  }
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
