// Importing the connection first guarantees the DB is opened and migrations
// have run before any route module prepares its statements.
import './db/connection';

import express from 'express';
import http from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { initSocket } from './socket/server';
import { notFoundHandler, errorHandler } from './middleware/error';
import webhookRouter from './routes/webhook';
import briefingsRouter from './routes/briefings';
import tradesRouter from './routes/trades';
import healthRouter from './routes/health';
import chartsRouter from './routes/charts';
import newsRouter from './routes/news';
import agentsRouter from './routes/agents';
import assistantRouter from './routes/assistant';
import { startCleanupJob } from './services/maintenance';
import { startLivePrices } from './services/livePrices';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Minimal, zero-dependency CORS for the REST API (Socket.io handles its own).
// Reflects only origins listed in CORS_ORIGINS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use('/health', healthRouter);
app.use('/webhook', webhookRouter);
app.use('/briefings', briefingsRouter);
app.use('/trades', tradesRouter);
app.use('/charts', chartsRouter);
app.use('/news', newsRouter);
app.use('/agents', agentsRouter);
app.use('/assistant', assistantRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
initSocket(server);

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Hermes backend listening');
  // Background jobs: purge stale briefings + stream live price/P&L ticks.
  startCleanupJob();
  startLivePrices();
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
