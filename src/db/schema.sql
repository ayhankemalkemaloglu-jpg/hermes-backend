CREATE TABLE IF NOT EXISTS briefings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME NOT NULL,
  hour_label TEXT,
  overall TEXT,
  leader TEXT,
  crypto_aggr REAL,
  stock_aggr REAL,
  open_positions_count INTEGER,
  raw_message TEXT,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS briefing_symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  briefing_id INTEGER REFERENCES briefings(id) ON DELETE CASCADE,
  symbol TEXT,
  category TEXT,
  trend TEXT,
  aggr REAL
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  strategy TEXT,
  opened_at DATETIME NOT NULL,
  closed_at DATETIME,
  exit_price REAL,
  pnl_pct REAL,
  pnl_usd REAL,
  status TEXT NOT NULL,
  hold_minutes INTEGER,
  realized_r REAL,
  position_hash TEXT UNIQUE NOT NULL,
  price_precision_lost INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS open_positions_snapshots (
  briefing_id INTEGER REFERENCES briefings(id) ON DELETE CASCADE,
  symbol TEXT,
  side TEXT,
  entry_price REAL,
  strategy TEXT,
  position_hash TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  symbol TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  data_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_hash ON trades(position_hash);
CREATE INDEX IF NOT EXISTS idx_briefings_ts ON briefings(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
