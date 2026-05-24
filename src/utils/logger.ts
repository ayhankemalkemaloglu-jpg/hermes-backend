import pino from 'pino';
import { config } from '../config';

/**
 * In production we write structured JSON to LOG_PATH (sonic-boom creates the
 * directory if missing). In dev we pipe through pino-pretty for human-readable
 * colored output on stdout.
 */
export const logger = config.isProduction
  ? pino(
      { level: process.env.LOG_LEVEL ?? 'info' },
      pino.destination({ dest: config.LOG_PATH, sync: false, mkdir: true })
    )
  : pino({
      level: process.env.LOG_LEVEL ?? 'debug',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    });
