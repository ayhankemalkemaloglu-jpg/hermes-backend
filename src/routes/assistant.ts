import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { askAssistant } from '../services/assistant';
import { logger } from '../utils/logger';

const router = Router();

const Body = z.object({ message: z.string().min(1).max(1000) });

// POST /assistant — voice assistant: question + live panel context -> short TR reply.
router.post('/', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_body' });
    return;
  }
  if (!config.ASSISTANT_API_KEY) {
    res.json({
      ok: false,
      error: 'not_configured',
      reply: 'Asistan yapılandırılmamış: ASSISTANT_API_KEY ayarlı değil.',
    });
    return;
  }
  try {
    const reply = await askAssistant(parsed.data.message);
    res.json({ ok: true, reply });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'assistant request failed');
    res.json({ ok: false, error: 'assistant_error', reply: 'Asistana ulaşamadım, tekrar dener misin?' });
  }
});

export default router;
