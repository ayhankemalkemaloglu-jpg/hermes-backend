/**
 * Pure subscription-set math for the Binance WS manager. Kept free of any
 * `config`/logger import so it can be unit tested in isolation.
 */
export interface SubDiff {
  add: string[];
  remove: string[];
}

/** Diff between the currently-subscribed set and the desired set. */
export function diffSubscriptions(
  current: ReadonlySet<string>,
  desired: ReadonlySet<string>
): SubDiff {
  const add: string[] = [];
  const remove: string[] = [];
  for (const s of desired) if (!current.has(s)) add.push(s);
  for (const s of current) if (!desired.has(s)) remove.push(s);
  return { add, remove };
}

/** Binance stream name for a symbol's 1s mini-ticker. */
export function miniTickerStream(symbol: string): string {
  return `${symbol.toLowerCase()}@miniTicker`;
}
