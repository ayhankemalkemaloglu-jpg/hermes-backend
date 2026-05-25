import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { isBotCommand, isPm2Action } from '../services/agentCommands';
import {
  AgentError,
  agentAction,
  agentLogs,
  listAgents,
  sendBotCommand,
} from '../services/agents';

const router = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof AgentError) {
    const status = err.code === 'forbidden' ? 403 : err.code === 'not_configured' ? 501 : 502;
    res.status(status).json({ ok: false, error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ ok: false, error: 'internal', message: (err as Error).message });
}

/** Who issued an action — best-effort attribution for the audit log. */
function actor(req: Request): string {
  return (req.headers['x-actor'] as string) || req.ip || 'dashboard';
}

// GET /agents → pm2 process list + whether bot commands are wired.
router.get('/', requireAuth(config.AUTH_TOKEN), async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, agents: await listAgents(), commandable: Boolean(config.BOT_COMMAND_URL) });
  } catch (err) {
    fail(res, err);
  }
});

const LogsQuery = z.object({ lines: z.coerce.number().int().min(1).max(1000).default(200) });

// GET /agents/:name/logs?lines=200 → recent pm2 log lines.
router.get('/:name/logs', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  const q = LogsQuery.safeParse(req.query);
  const lines = q.success ? q.data.lines : 200;
  try {
    const logs = await agentLogs(req.params.name, lines);
    res.json({ ok: true, name: req.params.name, lines, logs });
  } catch (err) {
    fail(res, err);
  }
});

const ActionBody = z.object({ action: z.string() });

// POST /agents/:name/action { action: restart|stop|start } → pm2 lifecycle.
router.post('/:name/action', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  const body = ActionBody.safeParse(req.body);
  if (!body.success || !isPm2Action(body.data.action)) {
    res.status(400).json({ ok: false, error: 'invalid_action' });
    return;
  }
  try {
    const output = await agentAction(req.params.name, body.data.action, actor(req));
    res.json({ ok: true, name: req.params.name, action: body.data.action, output });
  } catch (err) {
    fail(res, err);
  }
});

const CommandBody = z.object({ command: z.string() });

// POST /agents/command { command: STOP_BOT|GET_STATUS|CLOSE_ALL_POSITIONS }.
router.post('/command', requireAuth(config.AUTH_TOKEN), async (req: Request, res: Response) => {
  const body = CommandBody.safeParse(req.body);
  if (!body.success || !isBotCommand(body.data.command)) {
    res.status(400).json({ ok: false, error: 'invalid_command' });
    return;
  }
  try {
    const result = await sendBotCommand(body.data.command, actor(req));
    res.json({ ok: result.ok, result });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
