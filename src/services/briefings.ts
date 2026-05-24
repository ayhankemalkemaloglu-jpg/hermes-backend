import { db } from '../db/connection';
import { ParsedBriefing } from '../parser/types';

export interface BriefingRow {
  id: number;
  timestamp: string;
  hour_label: string | null;
  overall: string | null;
  leader: string | null;
  crypto_aggr: number | null;
  stock_aggr: number | null;
  open_positions_count: number | null;
  raw_message: string | null;
  received_at: string;
}

export interface BriefingSymbolRow {
  id: number;
  briefing_id: number;
  symbol: string;
  category: string;
  trend: string;
  aggr: number;
}

export interface SnapshotRow {
  briefing_id: number;
  symbol: string;
  side: string;
  entry_price: number;
  strategy: string;
  position_hash: string;
}

const insertBriefingStmt = db.prepare(`
  INSERT INTO briefings
    (timestamp, hour_label, overall, leader, crypto_aggr, stock_aggr, open_positions_count, raw_message)
  VALUES
    (@timestamp, @hour_label, @overall, @leader, @crypto_aggr, @stock_aggr, @open_positions_count, @raw_message)
`);

const insertSymbolStmt = db.prepare(`
  INSERT INTO briefing_symbols (briefing_id, symbol, category, trend, aggr)
  VALUES (@briefing_id, @symbol, @category, @trend, @aggr)
`);

const insertSnapshotStmt = db.prepare(`
  INSERT INTO open_positions_snapshots (briefing_id, symbol, side, entry_price, strategy, position_hash)
  VALUES (@briefing_id, @symbol, @side, @entry_price, @strategy, @position_hash)
`);

const insertEventStmt = db.prepare(`
  INSERT INTO events (type, symbol, data_json) VALUES (?, ?, ?)
`);

const latestBriefingStmt = db.prepare('SELECT * FROM briefings ORDER BY id DESC LIMIT 1');
const snapshotsByBriefingStmt = db.prepare(
  'SELECT * FROM open_positions_snapshots WHERE briefing_id = ?'
);

// Duplicate detection: a re-sent briefing has either the same (hour_label, day)
// or a byte-identical raw_message. We use SQLite's date() so two briefings for
// the same clock hour on the same UTC day collapse to one.
const duplicateByHourStmt = db.prepare(
  `SELECT id FROM briefings WHERE hour_label = ? AND date(timestamp) = date(?) LIMIT 1`
);
const duplicateByRawStmt = db.prepare('SELECT id FROM briefings WHERE raw_message = ? LIMIT 1');

/**
 * Return the id of an already-stored briefing that this one duplicates, or
 * undefined if it's new. Prevents the same hourly briefing piling up as 3 cards
 * (and prevents the trade-diff from churning on a re-send).
 */
export function findDuplicateBriefing(
  hourLabel: string | null,
  timestamp: string,
  rawMessage: string
): number | undefined {
  if (hourLabel) {
    const byHour = duplicateByHourStmt.get(hourLabel, timestamp) as { id: number } | undefined;
    if (byHour) return byHour.id;
  }
  const byRaw = duplicateByRawStmt.get(rawMessage) as { id: number } | undefined;
  return byRaw?.id;
}

export function getLatestBriefing(): BriefingRow | undefined {
  return latestBriefingStmt.get() as BriefingRow | undefined;
}

export function getSnapshotsForBriefing(briefingId: number): SnapshotRow[] {
  return snapshotsByBriefingStmt.all(briefingId) as SnapshotRow[];
}

/**
 * Insert a briefing together with its by-symbol rows and open-position
 * snapshot in a single transaction. better-sqlite3 transactions are
 * synchronous, so the whole write is atomic with no async window.
 */
export const insertBriefingWithChildren = db.transaction(
  (parsed: ParsedBriefing, timestamp: string): number => {
    const info = insertBriefingStmt.run({
      timestamp,
      hour_label: parsed.hour_label,
      overall: parsed.overall,
      leader: parsed.leader,
      crypto_aggr: parsed.crypto_aggr,
      stock_aggr: parsed.stock_aggr,
      open_positions_count: parsed.open_positions_count,
      raw_message: parsed.raw_message,
    });
    const briefingId = Number(info.lastInsertRowid);

    for (const s of parsed.symbols) {
      insertSymbolStmt.run({
        briefing_id: briefingId,
        symbol: s.symbol,
        category: s.category,
        trend: s.trend,
        aggr: s.aggr,
      });
    }

    for (const p of parsed.positions) {
      insertSnapshotStmt.run({
        briefing_id: briefingId,
        symbol: p.symbol,
        side: p.side,
        entry_price: p.entry_price,
        strategy: p.strategy,
        position_hash: p.position_hash,
      });
    }

    return briefingId;
  }
);

/** Append an audit/event row (PARSE_ERROR, etc.). */
export function recordEvent(type: string, symbol: string | null, data: unknown): void {
  insertEventStmt.run(type, symbol, data === undefined ? null : JSON.stringify(data));
}

/** Most recent N briefings, each with its by-symbol rows attached. */
export function getRecentBriefings(
  limit: number
): (BriefingRow & { symbols: BriefingSymbolRow[] })[] {
  const briefings = db
    .prepare('SELECT * FROM briefings ORDER BY timestamp DESC, id DESC LIMIT ?')
    .all(limit) as BriefingRow[];

  if (briefings.length === 0) return [];

  const ids = briefings.map((b) => b.id);
  const placeholders = ids.map(() => '?').join(',');
  const symbols = db
    .prepare(`SELECT * FROM briefing_symbols WHERE briefing_id IN (${placeholders})`)
    .all(...ids) as BriefingSymbolRow[];

  const byBriefing = new Map<number, BriefingSymbolRow[]>();
  for (const s of symbols) {
    const arr = byBriefing.get(s.briefing_id) ?? [];
    arr.push(s);
    byBriefing.set(s.briefing_id, arr);
  }

  return briefings.map((b) => ({ ...b, symbols: byBriefing.get(b.id) ?? [] }));
}
