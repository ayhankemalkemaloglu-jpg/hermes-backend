import { config } from '../config';
import { logger } from '../utils/logger';
import { fmtPrice } from '../utils/price';
import { getOpenTrades, getStats } from './trades';
import { getLatestBriefing } from './briefings';
import { resolveMarket } from './marketData';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AssistantError extends Error {
  constructor(
    message: string,
    public code: 'not_configured' | 'upstream'
  ) {
    super(message);
  }
}

/** Compact, factual snapshot of the live trading state for the system prompt. */
function gatherContext(): string {
  const open = getOpenTrades();
  const stats = getStats('24h');
  const briefing = getLatestBriefing();

  const lines: string[] = [];
  lines.push(`Açık pozisyon sayısı: ${open.length}`);
  for (const t of open.slice(0, 25)) {
    lines.push(
      `- ${t.symbol} ${t.side} giriş ${fmtPrice(t.entry_price)} [${resolveMarket(t.symbol)}]` +
        ` strateji=${t.strategy ?? '-'}`
    );
  }
  lines.push(
    `Performans (24s): win ${Math.round(stats.win_rate * 100)}% / lose ${Math.round(
      stats.loss_rate * 100
    )}%, kazanç ${stats.win_count}, kayıp ${stats.loss_count}, kapanan ${stats.closed_count}, ` +
      `toplam P&L ${stats.total_pnl_pct.toFixed(2)}%, profit factor ${
        stats.profit_factor === null ? '∞' : stats.profit_factor.toFixed(2)
      }`
  );
  if (briefing) {
    lines.push(
      `Son briefing (${briefing.hour_label ?? '?'}): genel=${briefing.overall ?? '-'}, ` +
        `lider=${briefing.leader ?? '-'}, kripto aggr=${briefing.crypto_aggr ?? '-'}, hisse aggr=${
          briefing.stock_aggr ?? '-'
        }`
    );
  }
  return lines.join('\n');
}

function buildSystemPrompt(): string {
  return (
    `Sen "Hermes"sin — bir kripto + Borsa İstanbul (BIST) trading komuta merkezinin asistanı. ` +
    `Kısa, net ve Türkçe konuş. Yanıtlarını yalnızca aşağıdaki canlı veriye ve genel finans bilgine ` +
    `dayandır; veri yoksa uydurma, "veri yok" de. Yatırım tavsiyesi verirken kesinlik iddia etme. ` +
    `Kullanıcı bir komut çalıştırmak isterse (pozisyon kapatma, botu durdurma vb.), bunu paneldeki ` +
    `komut butonlarından onaylı yapması gerektiğini söyle.\n\n[CANLI DURUM]\n${gatherContext()}`
  );
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ASSISTANT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.ASSISTANT_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new AssistantError(`upstream ${res.status}: ${JSON.stringify(data).slice(0, 300)}`, 'upstream');
    }
    return data;
  } catch (err) {
    if (err instanceof AssistantError) throw err;
    throw new AssistantError((err as Error).message, 'upstream');
  } finally {
    clearTimeout(timer);
  }
}

/** MiniMax chat completion v2 (OpenAI-style messages, base_resp status envelope). */
async function callMiniMax(system: string, history: ChatMessage[]): Promise<string> {
  const data = await postJson(`${config.ASSISTANT_API_BASE}/v1/text/chatcompletion_v2`, {
    model: config.ASSISTANT_MODEL,
    messages: [{ role: 'system', content: system }, ...history],
    stream: false,
  });
  const baseResp = data['base_resp'] as { status_code?: number; status_msg?: string } | undefined;
  if (baseResp && baseResp.status_code !== 0) {
    throw new AssistantError(`minimax ${baseResp.status_code}: ${baseResp.status_msg}`, 'upstream');
  }
  return extractContent(data);
}

/** OpenAI-compatible chat completions (also covers most proxies). */
async function callOpenAI(system: string, history: ChatMessage[]): Promise<string> {
  const data = await postJson(`${config.ASSISTANT_API_BASE}/v1/chat/completions`, {
    model: config.ASSISTANT_MODEL,
    messages: [{ role: 'system', content: system }, ...history],
    stream: false,
  });
  return extractContent(data);
}

function extractContent(data: Record<string, unknown>): string {
  const choices = data['choices'] as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new AssistantError('boş yanıt', 'upstream');
  }
  return content;
}

/** Answer a chat turn with live trading context. Throws AssistantError on failure. */
export async function chat(history: ChatMessage[]): Promise<string> {
  if (!config.ASSISTANT_API_KEY) {
    throw new AssistantError('ASSISTANT_API_KEY not configured', 'not_configured');
  }
  const system = buildSystemPrompt();
  const reply =
    config.ASSISTANT_PROVIDER === 'openai'
      ? await callOpenAI(system, history)
      : await callMiniMax(system, history);
  logger.info({ provider: config.ASSISTANT_PROVIDER, turns: history.length }, 'Assistant reply');
  return reply;
}
