/**
 * Decide whether a trade symbol is a crypto pair (priced on Binance) or a Borsa
 * İstanbul (BIST) equity (priced on Yahoo Finance as `<TICKER>.IS`).
 *
 * Hermes briefings emit crypto positions as Binance pairs that always end in a
 * quote asset (e.g. `DOGEUSDT`, `BTCUSDT`), while BIST tickers are bare symbols
 * (`THYAO`, `GARAN`). So: a known crypto-quote suffix → CRYPTO, otherwise BIST.
 * An explicit allowlist (config `BIST_SYMBOLS`) overrides the heuristic for any
 * edge case where a BIST ticker would collide with a quote suffix.
 *
 * This module is intentionally free of any `config`/DB import so it can be unit
 * tested in isolation (importing `config` would run startup validation).
 */
export type Market = 'CRYPTO' | 'BIST';

// Binance quote assets a crypto pair can end with. Longest-first doesn't matter
// here (anchored `$`), but the set is kept explicit so the rule is auditable.
const CRYPTO_QUOTE_RE = /(USDT|USDC|BUSD|FDUSD|TUSD|DAI|USD|TRY|BTC|ETH|BNB|EUR|GBP)$/;

const EMPTY: ReadonlySet<string> = new Set();

export function classifyMarket(
  symbol: string,
  bistSymbols: ReadonlySet<string> = EMPTY
): Market {
  const s = symbol.toUpperCase();
  if (bistSymbols.has(s)) return 'BIST';
  if (CRYPTO_QUOTE_RE.test(s)) return 'CRYPTO';
  // Bare ticker with no quote suffix — in this system that means a BIST equity.
  return 'BIST';
}
