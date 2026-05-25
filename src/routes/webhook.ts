import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { parseBriefing } from '../parser/briefing';
import {
  insertBriefingWithChildren,
  getLatestBriefing,
  getSnapshotsForBriefing,
  findDuplicateBriefing,
  recordEvent,
} from '../services/briefings';
import { runTradeDiff } from '../services/trades';
import { broadcast } from '../socket/server';
import { resolveTimestamp } from '../utils/time';
import { logger } from '../utils/logger';

const router = Router();

const BodySchema = z.object({
  message: z.string().min(10),
  timestamp: z.string().datetime().optional(),
});

router.post(
  '/hermes',
  requireAuth(config.WEBHOOK_SECRET),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = BodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_body', details: body.error.flatten().fieldErrors });
      return;
    }

    const { message } = body.data;
    const timestamp = resolveTimestamp(body.data.timestamp);
    logger.info({ len: message.length, timestamp }, 'Webhook hit: POST /webhook/hermes');

    // 1. Parse. A parse failure is recorded as an event but does NOT 500 —
    //    we don't want Telegram retrying a structurally bad message forever.
    let parsed;
    try {
      parsed = parseBriefing(message);
    } catch (err) {
      const reason = (err as Error).message;
      recordEvent('PARSE_ERROR', null, { reason, raw: message.slice(0, 500) });
      logger.error({ reason }, 'Briefing parse failed');
      res.status(200).json({ ok: false, error: 'parse_error', message: reason });
      return;
    }

    // 1b. Drop duplicates (same hour re-sent) so the dashboard doesn't pile up
    //     identical cards and the trade-diff doesn't churn on a re-send.
    const duplicateOf = findDuplicateBriefing(parsed.hour_label, timestamp, parsed.raw_message);
    if (duplicateOf !== undefined) {
      recordEvent('DUPLICATE_BRIEFING', null, { duplicate_of: duplicateOf, hour_label: parsed.hour_label });
      logger.info({ duplicateOf, hour_label: parsed.hour_label }, 'Duplicate briefing ignored');
      res.json({ ok: true, duplicate: true, briefing_id: duplicateOf });
      return;
    }

    // 2. Persist + diff. DB errors here are genuine 500s.
    try {
      // Capture the prior snapshot BEFORE inserting the new briefing.
      const prevBriefing = getLatestBriefing();
      const prevSnapshots = prevBriefing ? getSnapshotsForBriefing(prevBriefing.id) : [];

      const briefingId = insertBriefingWithChildren(parsed, timestamp);

      const { opened, closed } = await runTradeDiff(prevSnapshots, parsed.positions, timestamp);
      logger.info(
        { briefingId, opened: opened.length, closed: closed.length },
        'Trade diff complete'
      );

      // 3. Push to connected dashboards.
      broadcast('briefing:new', {
        briefing_id: briefingId,
        hour_label: parsed.hour_label,
        timestamp,
        overall: parsed.overall,
        leader: parsed.leader,
        open_positions_count: parsed.open_positions_count,
      });
      for (const t of opened) {
        broadcast('trade:open', t);
        // FINDING 3: surface a portfolio-risk breach to live dashboards. The
        // trade is still recorded (mirror mode); this just flags it.
        if (t.risk_breach) {
          broadcast('risk:breach', {
            trade_id: t.id,
            symbol: t.symbol,
            side: t.side,
            ...t.risk_breach,
          });
        }
      }
      for (const t of closed) broadcast('trade:close', t);
      if (opened.length || closed.length) broadcast('stats:update', { at: timestamp });

      res.json({
        ok: true,
        briefing_id: briefingId,
        opened_count: opened.length,
        closed_count: closed.length,
        parsed: {
          hour_label: parsed.hour_label,
          overall: parsed.overall,
          leader: parsed.leader,
          crypto_aggr: parsed.crypto_aggr,
          stock_aggr: parsed.stock_aggr,
          open_positions_count: parsed.open_positions_count,
          symbols: parsed.symbols.length,
          positions: parsed.positions.length,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
