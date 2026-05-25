import { ParsedBriefing, ParsedSymbol, Trend } from './types';
import { parsePositions } from './positions';

// The live agent's wording drifts (em/en-dash or hyphen, 1- or 2-digit hour,
// optional spaces), so every regex below is deliberately lenient.
const HOUR_RE = /Hourly Briefing\s*[—–-]\s*(\d{1,2}:\d{2})/;
const OVERALL_RE = /Overall:\s*(\w+)\s*\|\s*Leader:\s*(\w+)/;
const AGGR_RE = /Crypto aggr:\s*([\d.]+)\s*\|\s*Stock aggr:\s*([\d.]+)/;
// Anchor on "SYMBOL: <regime> (aggr <f>)" — the trend emoji is unreliable
// (sometimes glued to the symbol with no space), so we don't require it here
// and instead read it separately when present.
const SYMBOL_RE = /([A-Za-z0-9]+):\s*(\w+)\s*\(aggr\s*([\d.]+)\)/;
const TREND_EMOJI_RE = /(➡️|📈|📉)/;
const COUNT_RE = /Open Positions:\s*(\d+)/;
// A category header line is an all-caps word, optionally bracketed
// (e.g. "  CRYPTO", "  [CRYPTO]", "  STOCK").
const CATEGORY_RE = /^\s*\[?([A-Z]{2,})\]?\s*$/;

const TREND_MAP: Record<string, Trend> = {
  '➡️': 'range',
  '📈': 'trend_up',
  '📉': 'trend_down',
};

// Fallback when no emoji is present: derive the trend from the regime word.
const WORD_TREND: Record<string, Trend> = {
  range: 'range',
  trendup: 'trend_up',
  trend_up: 'trend_up',
  trenddown: 'trend_down',
  trend_down: 'trend_down',
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
      // Prefer the emoji when present (most reliable); otherwise fall back to
      // the regime word, then to 'range'.
      const emojiMatch = line.match(TREND_EMOJI_RE);
      const trendFromEmoji = emojiMatch ? TREND_MAP[emojiMatch[1]] : undefined;
      const trendFromWord = WORD_TREND[symMatch[2].toLowerCase()];
      symbols.push({
        symbol: symMatch[1].toUpperCase(),
        category: currentCategory,
        trend: trendFromEmoji ?? trendFromWord ?? 'range',
        aggr: parseFloat(symMatch[3]),
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
