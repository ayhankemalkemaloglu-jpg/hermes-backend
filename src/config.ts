import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Environment schema. Validated once at startup; if anything is missing or
 * malformed we fail fast with a clear message rather than crashing mid-request.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  AUTH_TOKEN: z.string().min(8, 'AUTH_TOKEN must be at least 8 chars'),
  WEBHOOK_SECRET: z.string().min(8, 'WEBHOOK_SECRET must be at least 8 chars'),
  DB_PATH: z.string().default('./hermes.db'),
  LOG_PATH: z.string().default('./app.log'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  BINANCE_API_BASE: z.string().url().default('https://api.binance.com'),
  // Binance WebSocket base for live crypto prices (@miniTicker, ~1s per symbol).
  BINANCE_WS_BASE: z.string().url().default('wss://stream.binance.com:9443/ws'),
  // Yahoo Finance base used to price BIST (Borsa İstanbul) equities as `<TICKER>.IS`.
  YAHOO_API_BASE: z.string().url().default('https://query1.finance.yahoo.com'),
  // Optional explicit BIST ticker allowlist (comma-separated). Overrides the
  // symbol-shape heuristic for any equity that would collide with a crypto
  // quote suffix. Bare tickers are treated as BIST even when this is empty.
  BIST_SYMBOLS: z.string().default(''),
  // How often BIST equities are polled from Yahoo (no free stream; per-second
  // polling gets rate-limited, so keep this at a few seconds).
  BIST_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  // Cadence at which the unified live snapshot (price:update + pnl:update) is
  // broadcast to dashboards. Decoupled from the source feeds.
  LIVE_BROADCAST_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),

  // --- Agent control (VPS Agent tab) ---------------------------------------
  // The trading bot's command webhook (uniswap-v3-monitor /webhook/command) and
  // its bearer token. When unset, the command endpoint reports "not configured"
  // instead of sending anything.
  BOT_COMMAND_URL: z.string().url().optional(),
  BOT_AUTH_TOKEN: z.string().optional(),
  // Comma-separated pm2 process names the dashboard may inspect/manage. Empty =
  // allow all processes pm2 reports (status/logs only; actions still allowlisted).
  AGENT_PM2_NAMES: z.string().default(''),
  // Timeout for outgoing bot command requests.
  BOT_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // Briefings older than this are purged by the cleanup job.
  BRIEFING_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // How often the cleanup job runs.
  CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  // Brave Search API token for the /news endpoint (optional — news disabled if unset).
  BRAVE_API_KEY: z.string().optional(),

  // --- Portfolio risk guard (FINDING 3) ------------------------------------
  // Enabled by default; runs in record-and-flag mode (never drops a mirrored
  // trade, only emits a RISK_BREACH event). Set RISK_ENABLED=false to disable.
  RISK_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s.toLowerCase() !== 'false'),
  // Stop admitting new positions once realized P&L for the UTC day <= -this (USD).
  RISK_DAILY_LOSS_LIMIT: z.coerce.number().nonnegative().default(500),
  // Max total notional across the whole book (USD).
  RISK_TOTAL_CAP: z.coerce.number().positive().default(10_000),
  // Max notional in a single symbol (USD).
  RISK_SYMBOL_CAP: z.coerce.number().positive().default(3_000),
  // Max notional within a correlation group (USD; default group = all crypto).
  RISK_CORRELATED_CAP: z.coerce.number().positive().default(8_000),
  // Duplicate if same symbol+side is open within this fraction of price (0.0015 = 0.15%).
  RISK_DUPLICATE_PRICE_PCT: z.coerce.number().nonnegative().default(0.0015),
  // Briefings carry no size, so each position counts as this fixed notional (USD).
  RISK_DEFAULT_NOTIONAL: z.coerce.number().positive().default(1_000),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // logger depends on config, so we can't use it here — fall back to console.
  // eslint-disable-next-line no-console
  console.error(
    '[config] Invalid environment configuration:',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)
  );
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  /** Parsed comma-separated CORS origins as a clean array. */
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Explicit BIST ticker allowlist, uppercased, as a fast-lookup set. */
  bistSymbols: new Set(
    env.BIST_SYMBOLS.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  ),
  /** pm2 process names the dashboard may inspect/manage (empty = all). */
  agentNames: env.AGENT_PM2_NAMES.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  isProduction: env.NODE_ENV === 'production',
  isDev: env.NODE_ENV !== 'production',
};

export type AppConfig = typeof config;
