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
