import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PortfolioGuard,
  PortfolioGuardConfig,
  DailyRealizedPnl,
  DEFAULT_CORRELATION_GROUP,
  RiskPosition,
} from './portfolioGuard';

const baseCfg: PortfolioGuardConfig = {
  dailyLossLimit: 500,
  totalCap: 10_000,
  symbolCap: 3_000,
  correlatedCap: 8_000,
  duplicatePricePct: 0.0015, // 0.15%
  correlationGroup: DEFAULT_CORRELATION_GROUP,
};

function guard(overrides: Partial<PortfolioGuardConfig> = {}): PortfolioGuard {
  return new PortfolioGuard({ ...baseCfg, ...overrides });
}

function pos(symbol: string, side: string, entry_price: number, notional = 1_000): RiskPosition {
  return { symbol, side, entry_price, notional };
}

test('admits a clean candidate into an empty book', () => {
  const v = guard().admit(pos('BTCUSDT', 'LONG', 60_000), [], 0);
  assert.equal(v.ok, true);
  assert.equal(v.reason, undefined);
});

test('daily_loss_breaker fires when realized P&L hits the negative limit', () => {
  const v = guard().admit(pos('BTCUSDT', 'LONG', 60_000), [], -500);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'daily_loss_breaker');
});

test('daily_loss_breaker does NOT fire just above the limit', () => {
  const v = guard().admit(pos('BTCUSDT', 'LONG', 60_000), [], -499.99);
  assert.equal(v.ok, true);
});

test('total_cap rejects when total notional would exceed the cap', () => {
  const open = [
    pos('ETHUSDT', 'LONG', 3_000, 2_375),
    pos('SOLUSDT', 'LONG', 150, 2_375),
    pos('ADAUSDT', 'LONG', 0.5, 2_375),
    pos('XRPUSDT', 'LONG', 0.6, 2_375),
  ]; // 9_500 total
  const v = guard({ correlatedCap: 1_000_000 }).admit(pos('AVAXUSDT', 'LONG', 30, 1_000), open, 0);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'total_cap');
});

test('symbol_cap rejects when one symbol gets too concentrated', () => {
  const open = [pos('BTCUSDT', 'LONG', 60_000, 1_400), pos('BTCUSDT', 'LONG', 61_000, 1_400)];
  const v = guard({ totalCap: 1_000_000, correlatedCap: 1_000_000 }).admit(
    pos('BTCUSDT', 'LONG', 62_000, 1_000),
    open,
    0
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'symbol_cap');
});

test('duplicate_entry rejects same symbol+side within 0.15%', () => {
  const open = [pos('BTCUSDT', 'LONG', 60_000)];
  const v = guard({ totalCap: 1e9, symbolCap: 1e9, correlatedCap: 1e9 }).admit(
    pos('BTCUSDT', 'LONG', 60_060), // +0.10%
    open,
    0
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'duplicate_entry');
});

test('duplicate_entry allows the same symbol+side outside the price band', () => {
  const open = [pos('BTCUSDT', 'LONG', 60_000)];
  const v = guard({ totalCap: 1e9, symbolCap: 1e9, correlatedCap: 1e9 }).admit(
    pos('BTCUSDT', 'LONG', 60_300), // +0.5%
    open,
    0
  );
  assert.equal(v.ok, true);
});

test('duplicate_entry ignores the opposite side at the same price', () => {
  const open = [pos('BTCUSDT', 'LONG', 60_000)];
  const v = guard({ totalCap: 1e9, symbolCap: 1e9, correlatedCap: 1e9 }).admit(
    pos('BTCUSDT', 'SHORT', 60_000),
    open,
    0
  );
  assert.equal(v.ok, true);
});

test('correlated_exposure_cap rejects when the correlation group is too large', () => {
  // Default grouping puts every crypto in one group.
  const open = [
    pos('BTCUSDT', 'LONG', 60_000, 3_000),
    pos('ETHUSDT', 'LONG', 3_000, 3_000),
    pos('SOLUSDT', 'LONG', 150, 1_500),
  ]; // 7_500 in group CRYPTO
  const v = guard({ totalCap: 1e9, symbolCap: 1e9 }).admit(
    pos('AVAXUSDT', 'LONG', 30, 1_000),
    open,
    0
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'correlated_exposure_cap');
});

test('correlated_exposure_cap respects custom grouping (uncorrelated symbols pass)', () => {
  const byPrefix = (s: string): string => (s.startsWith('BTC') ? 'BTC' : 'ALT');
  const open = [pos('BTCUSDT', 'LONG', 60_000, 7_500)];
  const v = guard({ totalCap: 1e9, symbolCap: 1e9, correlationGroup: byPrefix }).admit(
    pos('SOLUSDT', 'LONG', 150, 1_000), // group ALT, independent of BTC's exposure
    open,
    0
  );
  assert.equal(v.ok, true);
});

test('priority: daily_loss_breaker wins over total_cap', () => {
  const open = [pos('ETHUSDT', 'LONG', 3_000, 9_500)];
  const v = guard().admit(pos('BTCUSDT', 'LONG', 60_000, 1_000), open, -600);
  assert.equal(v.reason, 'daily_loss_breaker');
});

test('priority: total_cap wins over symbol_cap', () => {
  // Same symbol so symbol_cap would also trip, but total is checked first.
  const open = [pos('BTCUSDT', 'LONG', 60_000, 2_500)];
  const v = guard({ totalCap: 3_000, symbolCap: 3_000, correlatedCap: 1e9 }).admit(
    pos('BTCUSDT', 'LONG', 70_000, 1_000),
    open,
    0
  );
  assert.equal(v.reason, 'total_cap');
});

test('priority: symbol_cap wins over duplicate_entry', () => {
  // Same symbol+side at the same price (would be a duplicate) but symbol_cap is first.
  const open = [pos('BTCUSDT', 'LONG', 60_000, 2_500)];
  const v = guard({ totalCap: 1e9, symbolCap: 3_000, correlatedCap: 1e9 }).admit(
    pos('BTCUSDT', 'LONG', 60_000, 1_000),
    open,
    0
  );
  assert.equal(v.reason, 'symbol_cap');
});

// --- DailyRealizedPnl -------------------------------------------------------

test('DailyRealizedPnl accumulates within the same UTC day', () => {
  const d = new Date('2026-05-25T08:00:00Z');
  const tracker = new DailyRealizedPnl(d);
  tracker.add(-100, new Date('2026-05-25T09:00:00Z'));
  tracker.add(-50, new Date('2026-05-25T18:00:00Z'));
  assert.equal(tracker.today(new Date('2026-05-25T23:59:59Z')), -150);
});

test('DailyRealizedPnl resets at the UTC day boundary', () => {
  const tracker = new DailyRealizedPnl(new Date('2026-05-25T08:00:00Z'));
  tracker.add(-300, new Date('2026-05-25T20:00:00Z'));
  assert.equal(tracker.today(new Date('2026-05-25T23:00:00Z')), -300);
  // New UTC day -> reset to 0.
  assert.equal(tracker.today(new Date('2026-05-26T00:00:01Z')), 0);
  tracker.add(25, new Date('2026-05-26T01:00:00Z'));
  assert.equal(tracker.today(new Date('2026-05-26T02:00:00Z')), 25);
});
