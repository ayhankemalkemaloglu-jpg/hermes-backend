import { db } from '../db/connection';
import { ParsedPosition } from '../parser/types';
import { SnapshotRow } from './briefings';
import { getCurrentPrice } from './binance';
import { holdMinutes } from '../utils/time';
import { logger } from '../utils/logger';

export interface TradeRow {
  id: number;
  symbol: string;
  side: string;
  entry_price: number;
  strategy: string | null;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  status: string;
  hold_minutes: number | null;
  realized_r: number | null;
  position_hash: string;
  price_precision_lost: number;
}

export type StatsWindow = '24h' | '7d' | '30d' | 'all';

// INSERT OR IGNORE: position_hash is UNIQUE, so a hash we've already opened is
// silently skipped (info.changes === 0) rather than throwing.
const insertTradeStmt = db.prepare(`
  INSERT OR IGNORE INTO trades
    (symbol, side, entry_price, strategy, opened_at, status, position_hash, price_precision_lost)
  VALUES
    (@symbol, @side, @entry_price, @strategy, @opened_at, 'OPEN', @position_hash, @price_precision_lost)
`);

const openTradeByHashStmt = db.prepare(
  `SELECT * FROM trades WHERE position_hash = ? AND status = 'OPEN'`
);

const tradeByIdStmt = db.prepare('SELECT * FROM trades WHERE id = ?');

const closeTradeStmt = db.prepare(`
  UPDATE trades
  SET status = @status,
      closed_at = @closed_at,
      exit_price = @exit_price,
      pnl_pct = @pnl_pct,
      pnl_usd = @pnl_usd,
      hold_minutes = @hold_minutes
  WHERE id = @id
`);

export interface DiffResult {
  opened: TradeRow[];
  closed: TradeRow[];
}

/** LONG profits when price rises; SHORT profits when price falls. */
export function computePnlPct(side: string, entry: number, exit: number): number {
  if (entry === 0) return 0;
  return side === 'LONG' ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
}

const openTradesStmt = db.prepare(`SELECT * FROM trades WHERE status = 'OPEN'`);

/** All currently-open trades — used by the live price/P&L poller. */
export function getOpenTrades(): TradeRow[] {
  return openTradesStmt.all() as TradeRow[];
}

/**
 * Compare the previous briefing's open-position snapshot against the new
 * briefing's positions:
 *   - hashes present now but not before  -> a position OPENED
 *   - hashes present before but not now  -> a position CLOSED
 * Closing fetches an exit price from Binance; if that fails the trade is
 * recorded as CLOSED_NO_EXIT with a null exit price.
 */
export async function runTradeDiff(
  prevSnapshots: SnapshotRow[],
  newPositions: ParsedPosition[],
  newTimestamp: string
): Promise<DiffResult> {
  const prevByHash = new Map(prevSnapshots.map((s) => [s.position_hash, s]));
  const newByHash = new Map(newPositions.map((p) => [p.position_hash, p]));

  const opened: TradeRow[] = [];
  const closed: TradeRow[] = [];

  // --- Newly opened positions -------------------------------------------
  for (const [hash, pos] of newByHash) {
    if (prevByHash.has(hash)) continue;

    const info = insertTradeStmt.run({
      symbol: pos.symbol,
      side: pos.side,
      entry_price: pos.entry_price,
      strategy: pos.strategy,
      opened_at: newTimestamp,
      position_hash: hash,
      price_precision_lost: pos.price_precision_lost ? 1 : 0,
    });

    if (info.changes > 0) {
      opened.push(tradeByIdStmt.get(Number(info.lastInsertRowid)) as TradeRow);
    } else {
      logger.warn({ hash, symbol: pos.symbol }, 'Trade open skipped (hash already exists)');
    }
  }

  // --- Closed (vanished) positions --------------------------------------
  for (const [hash, snap] of prevByHash) {
    if (newByHash.has(hash)) continue;

    const openTrade = openTradeByHashStmt.get(hash) as TradeRow | undefined;
    if (!openTrade) continue; // never opened by us (e.g. seeded in first briefing)

    const hold = holdMinutes(openTrade.opened_at, newTimestamp);
    const exitPrice = await getCurrentPrice(snap.symbol);

    if (exitPrice === null) {
      closeTradeStmt.run({
        id: openTrade.id,
        status: 'CLOSED_NO_EXIT',
        closed_at: newTimestamp,
        exit_price: null,
        pnl_pct: null,
        pnl_usd: null,
        hold_minutes: hold,
      });
    } else {
      const pnlPct = computePnlPct(openTrade.side, openTrade.entry_price, exitPrice);
      closeTradeStmt.run({
        id: openTrade.id,
        status: 'CLOSED',
        closed_at: newTimestamp,
        exit_price: exitPrice,
        pnl_pct: pnlPct,
        pnl_usd: null,
        hold_minutes: hold,
      });
    }

    closed.push(tradeByIdStmt.get(openTrade.id) as TradeRow);
  }

  return { opened, closed };
}

// --------------------------------------------------------------------------
// Queries
// --------------------------------------------------------------------------

export function getTrades(filters: {
  status?: string;
  symbol?: string;
  limit: number;
}): TradeRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.symbol) {
    clauses.push('symbol = ?');
    params.push(filters.symbol.toUpperCase());
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit);

  return db
    .prepare(`SELECT * FROM trades ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params) as TradeRow[];
}

function windowCutoffIso(window: StatsWindow): string | null {
  if (window === 'all') return null;
  const durations: Record<Exclude<StatsWindow, 'all'>, number> = {
    '24h': 24 * 3_600_000,
    '7d': 7 * 24 * 3_600_000,
    '30d': 30 * 24 * 3_600_000,
  };
  return new Date(Date.now() - durations[window]).toISOString();
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

interface GroupStat {
  key: string;
  total_trades: number;
  closed_count: number;
  win_rate: number;
  avg_pnl_pct: number;
  total_pnl_pct: number;
}

function groupBy(rows: TradeRow[], keyFn: (r: TradeRow) => string): GroupStat[] {
  const groups = new Map<string, TradeRow[]>();
  for (const r of rows) {
    const key = keyFn(r) || 'unknown';
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const out: GroupStat[] = [];
  for (const [key, group] of groups) {
    const withPnl = group.filter((r): r is TradeRow & { pnl_pct: number } => r.pnl_pct !== null);
    const wins = withPnl.filter((r) => r.pnl_pct > 0).length;
    const total = withPnl.reduce((s, r) => s + r.pnl_pct, 0);
    out.push({
      key,
      total_trades: group.length,
      closed_count: withPnl.length,
      win_rate: withPnl.length ? round(wins / withPnl.length) : 0,
      avg_pnl_pct: withPnl.length ? round(total / withPnl.length) : 0,
      total_pnl_pct: round(total),
    });
  }
  return out.sort((a, b) => b.total_trades - a.total_trades);
}

export interface TradeStats {
  window: StatsWindow;
  total_trades: number;
  open_count: number;
  closed_count: number;
  win_rate: number;
  win_loss_ratio: number | null;
  avg_pnl_pct: number;
  total_pnl_pct: number;
  profit_factor: number | null;
  by_symbol: GroupStat[];
  by_strategy: GroupStat[];
}

export function getStats(window: StatsWindow): TradeStats {
  const cutoff = windowCutoffIso(window);
  const rows = cutoff
    ? (db.prepare('SELECT * FROM trades WHERE opened_at >= ?').all(cutoff) as TradeRow[])
    : (db.prepare('SELECT * FROM trades').all() as TradeRow[]);

  const openCount = rows.filter((r) => r.status === 'OPEN').length;
  const closedRows = rows.filter((r) => r.status === 'CLOSED' || r.status === 'CLOSED_NO_EXIT');
  const withPnl = closedRows.filter(
    (r): r is TradeRow & { pnl_pct: number } => r.pnl_pct !== null
  );

  const wins = withPnl.filter((r) => r.pnl_pct > 0);
  const losses = withPnl.filter((r) => r.pnl_pct <= 0);
  const grossProfit = wins.reduce((s, r) => s + r.pnl_pct, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl_pct, 0));
  const totalPnl = withPnl.reduce((s, r) => s + r.pnl_pct, 0);

  return {
    window,
    total_trades: rows.length,
    open_count: openCount,
    closed_count: closedRows.length,
    win_rate: withPnl.length ? round(wins.length / withPnl.length) : 0,
    // null when there are no losses yet — avoids non-serializable Infinity.
    win_loss_ratio: losses.length ? round(wins.length / losses.length) : null,
    avg_pnl_pct: withPnl.length ? round(totalPnl / withPnl.length) : 0,
    total_pnl_pct: round(totalPnl),
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    by_symbol: groupBy(rows, (r) => r.symbol),
    by_strategy: groupBy(rows, (r) => r.strategy ?? 'unknown'),
  };
}
