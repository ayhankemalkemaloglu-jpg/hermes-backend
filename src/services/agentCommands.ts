/**
 * Pure helpers + validators for the agent-control layer. No `config`, execFile,
 * or network import, so this is unit-testable in isolation.
 */

/** Commands the trading bot accepts at POST /webhook/command. */
export const KNOWN_BOT_COMMANDS = ['STOP_BOT', 'GET_STATUS', 'CLOSE_ALL_POSITIONS'] as const;
export type BotCommand = (typeof KNOWN_BOT_COMMANDS)[number];

const BOT_COMMAND_SET: ReadonlySet<string> = new Set(KNOWN_BOT_COMMANDS);
export function isBotCommand(value: unknown): value is BotCommand {
  return typeof value === 'string' && BOT_COMMAND_SET.has(value);
}

/** Reading-only commands run without a confirmation step on the client. */
export function isReadOnlyCommand(command: BotCommand): boolean {
  return command === 'GET_STATUS';
}

/** pm2 lifecycle actions the dashboard may trigger. */
export const PM2_ACTIONS = ['restart', 'stop', 'start'] as const;
export type Pm2Action = (typeof PM2_ACTIONS)[number];

const PM2_ACTION_SET: ReadonlySet<string> = new Set(PM2_ACTIONS);
export function isPm2Action(value: unknown): value is Pm2Action {
  return typeof value === 'string' && PM2_ACTION_SET.has(value);
}

/**
 * A process name is manageable when it's a non-empty plain identifier (so it can
 * never inject extra execFile args) AND, when an allowlist is configured, is on
 * it. An empty allowlist means "any process pm2 reports" (status/logs only).
 */
export function isAllowedAgent(name: string, allowlist: readonly string[]): boolean {
  if (!/^[\w.-]{1,64}$/.test(name)) return false;
  return allowlist.length === 0 || allowlist.includes(name);
}

export interface AgentStatus {
  name: string;
  status: string;
  cpu: number | null;
  memory: number | null;
  restarts: number | null;
  uptime_ms: number | null;
  pid: number | null;
}

/**
 * Parse `pm2 jlist` JSON into a trimmed status list, optionally filtered to an
 * allowlist. Tolerant of missing fields so a pm2 shape change degrades to nulls
 * rather than throwing.
 */
export function parsePm2List(raw: string, allowlist: readonly string[] = []): AgentStatus[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: AgentStatus[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name : '';
    if (!name) continue;
    if (allowlist.length > 0 && !allowlist.includes(name)) continue;

    const env = (p.pm2_env ?? {}) as Record<string, unknown>;
    const monit = (p.monit ?? {}) as Record<string, unknown>;
    const start = typeof env.pm_uptime === 'number' ? env.pm_uptime : null;
    out.push({
      name,
      status: typeof env.status === 'string' ? env.status : 'unknown',
      cpu: typeof monit.cpu === 'number' ? monit.cpu : null,
      memory: typeof monit.memory === 'number' ? monit.memory : null,
      restarts: typeof env.restart_time === 'number' ? env.restart_time : null,
      uptime_ms: start !== null ? Date.now() - start : null,
      pid: typeof p.pid === 'number' ? p.pid : null,
    });
  }
  return out;
}
