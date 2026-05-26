import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { AssistantError, chat } from '../services/assistant';

const router = Router();

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(20),
});

// POST /assistant/chat { messages: [{ role, content }] } → { ok, reply }
router.post('/chat', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  const body = ChatBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false, error: 'invalid_body' });
    return;
  }
  try {
    const reply = await chat(body.data.messages);
    res.json({ ok: true, reply });
  } catch (err) {
    if (err instanceof AssistantError) {
      res.status(err.code === 'not_configured' ? 501 : 502).json({
        ok: false,
        error: err.code,
        message: err.message,
      });
      return;
    }
    res.status(500).json({ ok: false, error: 'internal', message: (err as Error).message });
  }
});

// GET /assistant/health → whether the assistant is configured (for the UI to gate the tab).
router.get('/health', requireAuth(config.AUTH_TOKEN), (_req: Request, res: Response) => {
  res.json({ ok: true, configured: Boolean(config.ASSISTANT_API_KEY), provider: config.ASSISTANT_PROVIDER });
});

export default router;
