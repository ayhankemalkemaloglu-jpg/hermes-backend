/**
 * Portfolio-level admission control. Individual symbols would otherwise each
 * open in isolation — and since the book is overwhelmingly BTC-correlated, that
 * is really one big directional bet with no global cap. `PortfolioGuard.admit`
 * vets a candidate position against ALL open positions and today's realized
 * P&L, returning the first failing check (RED) or `{ ok: true }`.
 *
 * Checks run in a fixed priority order — the cheapest, most decisive gate first:
 *   1. daily_loss_breaker      — realized P&L for the UTC day has hit the limit
 *   2. total_cap               — total notional across the whole book
 *   3. symbol_cap              — notional in this one symbol
 *   4. duplicate_entry         — same symbol+side already open at ~the same price
 *   5. correlated_exposure_cap — notional within the candidate's correlation group
 *
 * Notional units are caller-defined (quote currency); the guard only sums and
 * compares them, so it is agnostic to how the wiring layer sizes positions.
 */

export interface RiskPosition {
  symbol: string;
  side: string;
  entry_price: number;
  notional: number;
}

export type Candidate = RiskPosition;

export type RejectReason =
  | 'daily_loss_breaker'
  | 'total_cap'
  | 'symbol_cap'
  | 'duplicate_entry'
  | 'correlated_exposure_cap';

export interface Verdict {
  ok: boolean;
  reason?: RejectReason;
  detail?: Record<string, number | string>;
}

export interface PortfolioGuardConfig {
  /** Reject every candidate once realized P&L for the UTC day <= -dailyLossLimit. */
  dailyLossLimit: number;
  /** Max total notional across all open positions + the candidate. */
  totalCap: number;
  /** Max notional in a single symbol + the candidate. */
  symbolCap: number;
  /** Max notional within the candidate's correlation group + the candidate. */
  correlatedCap: number;
  /** Duplicate if an open same-symbol/same-side position is within this fraction
   *  of the candidate's price (0.0015 = 0.15%). */
  duplicatePricePct: number;
  /** Maps a symbol to its correlation-group key. Default: everything is one
   *  group ("CRYPTO"), i.e. the whole crypto book is treated as correlated. */
  correlationGroup: (symbol: string) => string;
}

/** Default grouping: treat the entire (crypto) book as a single correlated group. */
export const DEFAULT_CORRELATION_GROUP = (_symbol: string): string => 'CRYPTO';

function sum(positions: RiskPosition[]): number {
  return positions.reduce((acc, p) => acc + p.notional, 0);
}

/** True when `a` and `b` are within `pct` of each other (relative difference). */
function withinPct(a: number, b: number, pct: number): boolean {
  const ref = Math.abs(b) || Math.abs(a);
  if (ref === 0) return a === b;
  return Math.abs(a - b) / ref <= pct;
}

export class PortfolioGuard {
  constructor(private readonly cfg: PortfolioGuardConfig) {}

  admit(candidate: Candidate, open: RiskPosition[], realizedPnlToday: number): Verdict {
    const { cfg } = this;

    // 1. Daily loss breaker — stop opening anything once the day is in the red.
    if (realizedPnlToday <= -cfg.dailyLossLimit) {
      return {
        ok: false,
        reason: 'daily_loss_breaker',
        detail: { realizedPnlToday, limit: cfg.dailyLossLimit },
      };
    }

    // 2. Total notional cap across the whole book.
    const projectedTotal = sum(open) + candidate.notional;
    if (projectedTotal > cfg.totalCap) {
      return {
        ok: false,
        reason: 'total_cap',
        detail: { projected: projectedTotal, cap: cfg.totalCap },
      };
    }

    // 3. Per-symbol notional cap.
    const projectedSymbol =
      sum(open.filter((p) => p.symbol === candidate.symbol)) + candidate.notional;
    if (projectedSymbol > cfg.symbolCap) {
      return {
        ok: false,
        reason: 'symbol_cap',
        detail: { symbol: candidate.symbol, projected: projectedSymbol, cap: cfg.symbolCap },
      };
    }

    // 4. Duplicate entry — same symbol+side already open at ~the same price.
    const dup = open.find(
      (p) =>
        p.symbol === candidate.symbol &&
        p.side === candidate.side &&
        withinPct(p.entry_price, candidate.entry_price, cfg.duplicatePricePct)
    );
    if (dup) {
      return {
        ok: false,
        reason: 'duplicate_entry',
        detail: {
          symbol: candidate.symbol,
          side: candidate.side,
          existing_price: dup.entry_price,
          candidate_price: candidate.entry_price,
        },
      };
    }

    // 5. Correlated-exposure cap — notional within the candidate's group.
    const group = cfg.correlationGroup(candidate.symbol);
    const projectedGroup =
      sum(open.filter((p) => cfg.correlationGroup(p.symbol) === group)) + candidate.notional;
    if (projectedGroup > cfg.correlatedCap) {
      return {
        ok: false,
        reason: 'correlated_exposure_cap',
        detail: { group, projected: projectedGroup, cap: cfg.correlatedCap },
      };
    }

    return { ok: true };
  }
}

/**
 * Accumulates realized P&L for the current UTC day and resets automatically when
 * the UTC date rolls over. All methods take an optional `now` so the wiring layer
 * can drive the clock from briefing timestamps (and tests can be deterministic).
 */
export class DailyRealizedPnl {
  private day: string;
  private pnl = 0;

  constructor(now: Date = new Date()) {
    this.day = utcDay(now);
  }

  private rollover(now: Date): void {
    const today = utcDay(now);
    if (today !== this.day) {
      this.day = today;
      this.pnl = 0;
    }
  }

  add(amount: number, now: Date = new Date()): void {
    this.rollover(now);
    this.pnl += amount;
  }

  today(now: Date = new Date()): number {
    this.rollover(now);
    return this.pnl;
  }
}

/** UTC calendar day as "YYYY-MM-DD". */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
