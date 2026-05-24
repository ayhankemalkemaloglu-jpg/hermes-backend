import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { config } from '../config';
import { timingSafeEqualStr } from '../middleware/auth';
import { logger } from '../utils/logger';

let io: SocketIOServer | null = null;

/**
 * Attach Socket.io to the HTTP server. Clients must present a Bearer token via
 * handshake.auth.token (checked in constant time). CORS origins come from the
 * comma-separated CORS_ORIGINS env var.
 */
export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.corsOrigins,
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token || !timingSafeEqualStr(token, config.AUTH_TOKEN)) {
      logger.warn({ id: socket.id }, 'Socket auth rejected');
      next(new Error('unauthorized'));
      return;
    }
    next();
  });

  io.on('connection', (socket) => {
    logger.info({ id: socket.id }, 'Socket client connected');
    socket.on('disconnect', (reason) => {
      logger.info({ id: socket.id, reason }, 'Socket client disconnected');
    });
  });

  return io;
}

/** Broadcast an event to all connected clients. No-op if socket not yet up. */
export function broadcast(event: string, payload: unknown): void {
  if (!io) {
    logger.warn({ event }, 'broadcast() called before socket init');
    return;
  }
  io.emit(event, payload);
  logger.debug({ event }, 'Socket broadcast');
}
