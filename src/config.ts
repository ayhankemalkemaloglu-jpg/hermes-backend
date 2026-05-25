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
  // Live price/P&L poller cadence for open positions.
  PRICE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
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
  isProduction: env.NODE_ENV === 'production',
  isDev: env.NODE_ENV !== 'production',
};

export type AppConfig = typeof config;
