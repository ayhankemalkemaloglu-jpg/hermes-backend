import { config } from '../config';
import { logger } from '../utils/logger';
import { getStats, getTrades } from './trades';
import { getRecentBriefings } from './briefings';
import { fetchNews } from './news';

const TIMEOUT_MS = 20_000;

/** Compact live snapshot of the dashboard, fed to the LLM as grounding. */
async function buildContext(): Promise<string> {
  const lines: string[] = [];

  try {
    const s = getStats('24h');
    lines.push(
      `İstatistik (24s): açık ${s.open_count}, kapalı ${s.closed_count}, ` +
        `kazanma oranı %${Math.round(s.win_rate * 100)}, toplam P&L ${s.total_pnl_pct.toFixed(2)}%, ` +
        `ortalama ${s.avg_pnl_pct.toFixed(2)}%`
    );
  } catch {
    /* stats unavailable */
  }

  try {
    const open = getTrades({ status: 'OPEN', limit: 20 });
    lines.push(
      open.length
        ? `Açık pozisyonlar (${open.length}): ` +
            open
              .map((t) => `${t.symbol} ${t.side} giriş ${t.entry_price} [${t.strategy ?? '?'}]`)
              .join('; ')
        : 'Açık pozisyon yok.'
    );
  } catch {
    /* trades unavailable */
  }

  try {
    const [b] = getRecentBriefings(1);
    if (b) {
      const regimes = (b.symbols ?? [])
        .slice(0, 10)
        .map((x) => `${x.symbol}:${x.trend}`)
        .join(', ');
      lines.push(
        `Son briefing ${b.hour_label ?? ''}: genel ${b.overall ?? '?'}, lider ${b.leader ?? '?'}, ` +
          `kripto aggr ${b.crypto_aggr ?? '?'}, hisse aggr ${b.stock_aggr ?? '?'}` +
          (regimes ? `. Rejimler: ${regimes}` : '')
      );
    }
  } catch {
    /* briefing unavailable */
  }

  try {
    const news = await fetchNews('crypto', 5);
    if (news.length) lines.push('Son haberler: ' + news.map((n) => n.title).join(' | '));
  } catch {
    /* news unavailable */
  }

  return lines.join('\n');
}

/**
 * Ask the voice assistant. Grounds an OpenAI-compatible chat model
 * (Moonshot/Kimi by default) on a live dashboard snapshot and returns a short
 * Turkish reply suitable for text-to-speech. Throws on transport/LLM failure.
 */
export async function askAssistant(userMessage: string): Promise<string> {
  const key = config.ASSISTANT_API_KEY;
  if (!key) throw new Error('assistant_not_configured');

  const context = await buildContext();
  const system =
    'Sen "Hermes" adlı kripto/borsa trading komuta panelinin sesli Türkçe asistanısın. ' +
    'Cevapların KISA ve net olsun (en fazla 2-3 cümle; yüksek sesle okunacak, o yüzden tablo/markdown kullanma). ' +
    'Aşağıdaki CANLI PANEL VERİSİNİ kullan; veride olmayan bir şey sorulursa uydurma, bilmediğini söyle. ' +
    'Yalnızca Türkçe konuş.\n\n--- CANLI PANEL VERİSİ ---\n' +
    context;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.ASSISTANT_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: config.ASSISTANT_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.4,
        max_tokens: 300,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'assistant LLM returned non-OK');
      throw new Error(`llm_${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('llm_empty');
    return reply;
  } finally {
    clearTimeout(timer);
  }
}
