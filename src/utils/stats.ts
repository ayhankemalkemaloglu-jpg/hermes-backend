/** Round to a fixed number of decimals (default 4). */
export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export interface WinLoss {
  win_count: number;
  loss_count: number;
  win_rate: number;
  loss_rate: number;
}

/**
 * Win/loss breakdown over a set of realized P&L percentages. A trade counts as
 * a win when pnl > 0, otherwise a loss (break-even pnl === 0 is a loss). Rates
 * are fractions of the closed set, so `win_rate + loss_rate === 1` whenever any
 * trades are present, and both are 0 for an empty set.
 */
export function winLoss(pnls: number[]): WinLoss {
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const losses = n - wins;
  return {
    win_count: wins,
    loss_count: losses,
    win_rate: n ? round(wins / n) : 0,
    loss_rate: n ? round(losses / n) : 0,
  };
}
