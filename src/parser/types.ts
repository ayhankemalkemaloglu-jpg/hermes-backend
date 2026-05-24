/** Normalized trend, derived from the leading emoji of a symbol line. */
export type Trend = 'range' | 'trend_up' | 'trend_down';

export type Side = 'LONG' | 'SHORT';

export interface ParsedSymbol {
  symbol: string;
  category: string;
  trend: Trend;
  aggr: number;
}

export interface ParsedPosition {
  symbol: string;
  side: Side;
  entry_price: number;
  strategy: string;
  position_hash: string;
  /** true when entry_price parsed to 0 (precision lost upstream). */
  price_precision_lost: boolean;
}

export interface ParsedBriefing {
  hour_label: string | null;
  overall: string | null;
  leader: string | null;
  crypto_aggr: number | null;
  stock_aggr: number | null;
  open_positions_count: number | null;
  symbols: ParsedSymbol[];
  positions: ParsedPosition[];
  raw_message: string;
}
