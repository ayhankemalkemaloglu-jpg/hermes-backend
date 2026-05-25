import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config';
import { logger } from '../utils/logger';
import { recordEvent } from './briefings';
import {
  AgentStatus,
  BotCommand,
  Pm2Action,
  isAllowedAgent,
  parsePm2List,
} from './agentCommands';

const execFileAsync = promisify(execFile);
const PM2_TIMEOUT_MS = 8_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** Mirrors the bot's POST /webhook/command response shape (commander.ts). */
export interface CommandResponse {
  ok: boolean;
  command?: string;
  message?: string;
  data?: unknown;
  transportError?: string;
  httpStatus?: number;
}

class AgentError extends Error {
  constructor(
    message: string,
    public code: 'forbidden' | 'unavailable' | 'not_configured'
  ) {
    super(message);
  }
}
export { AgentError };

/** Live pm2 process list, trimmed + filtered to the configured allowlist. */
export async function listAgents(): Promise<AgentStatus[]> {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], {
      timeout: PM2_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return parsePm2List(stdout, config.agentNames);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pm2 jlist failed');
    throw new AgentError('pm2 unavailable', 'unavailable');
  }
}

/** Recent log lines for one process (`pm2 logs --nostream`). */
export async function agentLogs(name: string, lines: number): Promise<string> {
  if (!isAllowedAgent(name, config.agentNames)) {
    throw new AgentError('agent not allowed', 'forbidden');
  }
  const clamped = Math.max(1, Math.min(lines, 1000));
  try {
    const { stdout } = await execFileAsync(
      'pm2',
      ['logs', name, '--lines', String(clamped), '--nostream'],
      { timeout: PM2_TIMEOUT_MS, maxBuffer: MAX_BUFFER }
    );
    return stdout;
  } catch (err) {
    // pm2 logs can exit non-zero even with usable output; surface what we have.
    const e = err as { stdout?: string; message?: string };
    if (typeof e.stdout === 'string' && e.stdout.length) return e.stdout;
    logger.warn({ name, err: e.message }, 'pm2 logs failed');
    throw new AgentError('pm2 unavailable', 'unavailable');
  }
}

/** Run a pm2 lifecycle action on an allowlisted process; audited. */
export async function agentAction(name: string, action: Pm2Action, by: string): Promise<string> {
  if (!isAllowedAgent(name, config.agentNames)) {
    throw new AgentError('agent not allowed', 'forbidden');
  }
  recordEvent('AGENT_ACTION', name, { action, by });
  try {
    const { stdout } = await execFileAsync('pm2', [action, name], {
      timeout: PM2_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    logger.info({ name, action, by }, 'Agent pm2 action');
    return stdout;
  } catch (err) {
    logger.warn({ name, action, err: (err as Error).message }, 'pm2 action failed');
    throw new AgentError('pm2 action failed', 'unavailable');
  }
}

/**
 * Forward a command to the trading bot's command webhook (the same contract the
 * Hermes Agent / sepolia-pool-monitor uses). Every command is audited regardless
 * of outcome. Network failures resolve to ok:false rather than throwing.
 */
export async function sendBotCommand(command: BotCommand, by: string): Promise<CommandResponse> {
  if (!config.BOT_COMMAND_URL) {
    throw new AgentError('BOT_COMMAND_URL not configured', 'not_configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.BOT_COMMAND_TIMEOUT_MS);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.BOT_AUTH_TOKEN) headers['authorization'] = `Bearer ${config.BOT_AUTH_TOKEN}`;

  let result: CommandResponse;
  try {
    const res = await fetch(config.BOT_COMMAND_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command }),
      signal: controller.signal,
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body — rely on status */
    }
    result = {
      ok: res.ok && parsed['ok'] !== false,
      command: typeof parsed['command'] === 'string' ? (parsed['command'] as string) : command,
      message: typeof parsed['message'] === 'string' ? (parsed['message'] as string) : undefined,
      data: parsed['data'],
      httpStatus: res.status,
    };
  } catch (err) {
    result = { ok: false, command, transportError: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }

  recordEvent('AGENT_COMMAND', 'bot', {
    command,
    by,
    ok: result.ok,
    httpStatus: result.httpStatus,
    transportError: result.transportError,
  });
  logger.info({ command, by, ok: result.ok }, 'Bot command sent');
  return result;
}
