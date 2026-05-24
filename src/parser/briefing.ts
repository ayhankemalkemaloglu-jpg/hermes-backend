import { ParsedBriefing, ParsedSymbol, Trend } from './types';
import { parsePositions } from './positions';

const HOUR_RE = /Hourly Briefing\s+—\s+(\d{2}:\d{2})/;
const OVERALL_RE = /Overall:\s+(\w+)\s+\|\s+Leader:\s+(\w+)/;
const AGGR_RE = /Crypto aggr:\s+([\d.]+)\s+\|\s+Stock aggr:\s+([\d.]+)/;
const SYMBOL_RE = /(➡️|📈|📉)\s+(\w+):\s+(\w+)\s+\(aggr\s+([\d.]+)\)/;
const COUNT_RE = /Open Positions:\s+(\d+)/;
// A category header line is just an all-caps word (e.g. "  CRYPTO", "  STOCK").
const CATEGORY_RE = /^\s*([A-Z]{2,})\s*$/;

const TREND_MAP: Record<string, Trend> = {
  '➡️': 'range',
  '📈': 'trend_up',
  '📉': 'trend_down',
};

/**
 * Parse a Hermes hourly briefing message into a structured object. Designed to
 * degrade gracefully: any field that doesn't match becomes null / empty rather
 * than throwing, so a slightly-off message still produces a usable record.
 */
export function parseBriefing(raw: string): ParsedBriefing {
  const hourMatch = raw.match(HOUR_RE);
  const overallMatch = raw.match(OVERALL_RE);
  const aggrMatch = raw.match(AGGR_RE);
  const countMatch = raw.match(COUNT_RE);

  const symbols: ParsedSymbol[] = [];
  let currentCategory = 'UNKNOWN';
  let inSymbolSection = false;

  for (const line of raw.split('\n')) {
    if (/By Symbol:/.test(line)) {
      inSymbolSection = true;
      continue;
    }
    // The "Open Positions" header ends the by-symbol section.
    if (/Open Positions:/.test(line)) {
      inSymbolSection = false;
    }
    if (!inSymbolSection) continue;

    const symMatch = line.match(SYMBOL_RE);
    if (symMatch) {
      const emoji = symMatch[1];
      symbols.push({
        symbol: symMatch[2].toUpperCase(),
        category: currentCategory,
        // Trend is derived from the emoji, not the (sometimes noisy) word.
        trend: TREND_MAP[emoji] ?? 'range',
        aggr: parseFloat(symMatch[4]),
      });
      continue;
    }

    const catMatch = line.match(CATEGORY_RE);
    if (catMatch) {
      currentCategory = catMatch[1];
    }
  }

  return {
    hour_label: hourMatch ? hourMatch[1] : null,
    overall: overallMatch ? overallMatch[1] : null,
    leader: overallMatch ? overallMatch[2] : null,
    crypto_aggr: aggrMatch ? parseFloat(aggrMatch[1]) : null,
    stock_aggr: aggrMatch ? parseFloat(aggrMatch[2]) : null,
    open_positions_count: countMatch ? parseInt(countMatch[1], 10) : null,
    symbols,
    positions: parsePositions(raw),
    raw_message: raw,
  };
}
