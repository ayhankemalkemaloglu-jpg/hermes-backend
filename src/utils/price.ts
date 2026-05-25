/**
 * Format a price using significant figures instead of a fixed number of
 * decimals. Fixed decimals (e.g. `toFixed(4)`) collapse low-priced tokens —
 * PEPE at $0.0000123 renders as "0.0000" — so we instead keep `sig`
 * significant figures for sub-1 values.
 *
 * Port of the reference Python `fmt_price`:
 *   - non-finite -> the value's string form ("NaN" / "Infinity")
 *   - exactly 0  -> "0"
 *   - |v| >= 1   -> `big` fixed decimals
 *   - |v| < 1    -> enough decimals for `sig` significant figures, capped at `mx`
 *
 * @example fmtPrice(0.00001234) === "0.000012340"
 */
export function fmtPrice(v: number, sig = 5, big = 2, mx = 12): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1) return v.toFixed(big);
  const decimals = Math.min(mx, Math.max(0, sig - 1 - Math.floor(Math.log10(a))));
  return v.toFixed(decimals);
}
