/** Current time as an ISO-8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve the canonical timestamp for a briefing: prefer the explicitly
 * provided ISO timestamp, otherwise stamp "now".
 */
export function resolveTimestamp(provided?: string): string {
  return provided && provided.length > 0 ? provided : nowIso();
}

/**
 * Combine an "HH:MM" hour label with a base date (UTC) into an ISO timestamp.
 * Returns null if the label is malformed. Useful as a fallback when Hermes
 * sends only an hour label and no full timestamp.
 */
export function hourLabelToIso(hourLabel: string, base: Date = new Date()): string | null {
  const m = hourLabel.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(base);
  d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toISOString();
}

/**
 * Whole minutes a position was held, clamped to >= 0. Returns 0 if either
 * timestamp is unparseable so we never write NaN into the DB.
 */
export function holdMinutes(openedAt: string, closedAt: string): number {
  const opened = new Date(openedAt).getTime();
  const closed = new Date(closedAt).getTime();
  if (Number.isNaN(opened) || Number.isNaN(closed)) return 0;
  return Math.max(0, Math.round((closed - opened) / 60000));
}
