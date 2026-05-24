import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Constant-time string comparison. A naive `a === b` leaks information through
 * how quickly it returns (it bails at the first differing byte), which an
 * attacker can exploit to guess a token byte-by-byte. timingSafeEqual always
 * compares the full buffers.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Run a same-length compare to keep timing roughly constant, then fail.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Express middleware factory enforcing a Bearer token. We pass the expected
 * secret explicitly so the same factory guards the webhook (WEBHOOK_SECRET)
 * and the API routes (AUTH_TOKEN).
 */
export function requireAuth(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearer(req);
    if (!token || !timingSafeEqualStr(token, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
