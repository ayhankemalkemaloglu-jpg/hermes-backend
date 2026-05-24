import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/** 404 for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found', path: req.path });
}

/**
 * Central error handler. Express identifies this as an error handler by its
 * 4-argument signature, so `next` must stay in the signature even though it is
 * unused.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err: err.message, stack: err.stack, path: req.path }, 'Request error');
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', message: err.message });
}
