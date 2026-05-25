import { config } from '../../config';
import { PortfolioGuard, DailyRealizedPnl, DEFAULT_CORRELATION_GROUP } from './portfolioGuard';

/**
 * App-wired portfolio guard + realized-P&L tracker, configured from env.
 *
 * Briefings carry no position size, so the wiring layer treats every position as
 * one fixed notional unit (`RISK_NOTIONAL`); the notional caps therefore act as
 * position-count limits. `correlationGroup` defaults to a single crypto group,
 * i.e. the whole book is treated as correlated (FINDING 3's default).
 */
export const portfolioGuard = new PortfolioGuard({
  dailyLossLimit: config.RISK_DAILY_LOSS_LIMIT,
  totalCap: config.RISK_TOTAL_CAP,
  symbolCap: config.RISK_SYMBOL_CAP,
  correlatedCap: config.RISK_CORRELATED_CAP,
  duplicatePricePct: config.RISK_DUPLICATE_PRICE_PCT,
  correlationGroup: DEFAULT_CORRELATION_GROUP,
});

/** Realized P&L for the current UTC day; resets automatically at UTC midnight. */
export const dailyRealizedPnl = new DailyRealizedPnl();

export const RISK_ENABLED = config.RISK_ENABLED;
export const RISK_NOTIONAL = config.RISK_DEFAULT_NOTIONAL;

export type { Verdict } from './portfolioGuard';
