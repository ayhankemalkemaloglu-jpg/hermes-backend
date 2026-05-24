import crypto from 'crypto';
import { ParsedPosition, Side } from './types';

// e.g. "   dogeusdt LONG @ 0.1032 trend_pullback"
const POSITION_RE = /(\w+)\s+(LONG|SHORT)\s+@\s+([\d.]+)\s+\[?(\w+)\]?/;

/**
 * Stable identity for an open position. The same symbol+side+entry+strategy
 * tuple yields the same hash across briefings, which is what lets the diff
 * algorithm recognize a position that is still open vs. one that vanished.
 */
export function computePositionHash(
  symbol: string,
  side: string,
  entryPrice: number,
  strategy: string
): string {
  return crypto
    .createHash('md5')
    .update(`${symbol}|${side}|${entryPrice}|${strategy}`)
    .digest('hex');
}

/**
 * Parse the "Open Positions" block. We only scan lines that follow the
 * "Open Positions:" header so we never mis-parse the by-symbol section.
 */
export function parsePositions(raw: string): ParsedPosition[] {
  const lines = raw.split('\n');
  const positions: ParsedPosition[] = [];
  let inPositionSection = false;

  for (const line of lines) {
    if (/Open Positions:/.test(line)) {
      inPositionSection = true;
      continue;
    }
    if (!inPositionSection) continue;
    if (/No closed trades this hour/.test(line)) continue;

    const m = line.match(POSITION_RE);
    if (!m) continue;

    const symbol = m[1].toUpperCase();
    const side = m[2].toUpperCase() as Side;
    const entryPrice = parseFloat(m[3]);
    const strategy = m[4];

    positions.push({
      symbol,
      side,
      entry_price: entryPrice,
      strategy,
      position_hash: computePositionHash(symbol, side, entryPrice, strategy),
      price_precision_lost: entryPrice === 0,
    });
  }

  return positions;
}
