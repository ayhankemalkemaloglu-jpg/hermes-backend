import { config } from '../config';
import { logger } from '../utils/logger';

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  age: string | null;
  description: string | null;
  thumbnail: string | null;
}

/** Shape of a Brave web result (only the fields we use). */
interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  meta_url?: { hostname?: string };
  thumbnail?: { src?: string };
  profile?: { name?: string };
}

interface CacheEntry {
  items: NewsItem[];
  fetchedAt: number;
}

// Cache aggressively: the Brave free tier is rate/quota limited, and news does
// not change second-to-second. Keyed by query+count.
const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 6_000;
// Web search is included in the basic free plan (news search often is not),
// so we use it with a freshness filter to bias recent articles.
const BRAVE_WEB_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Fetch normalized recent results from Brave web search.
 *   - null  → not configured (no BRAVE_API_KEY) or hard failure with no cache.
 *   - []    → configured but no results.
 * On a transient failure we serve stale cache when available.
 */
export async function fetchNews(query: string, count = 15): Promise<NewsItem[] | null> {
  if (!config.BRAVE_API_KEY) return null;

  const safeCount = Math.min(Math.max(count, 1), 20);
  const cacheKey = `${query}::${safeCount}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.items;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `${BRAVE_WEB_URL}?q=${encodeURIComponent(query)}` +
      `&count=${safeCount}&spellcheck=0`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.BRAVE_API_KEY,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, body: body.slice(0, 200) },
        'Brave search returned non-OK',
      );
      return cached?.items ?? null;
    }
    const data = (await res.json()) as { web?: { results?: unknown } };
    const results = Array.isArray(data.web?.results)
      ? (data.web?.results as BraveResult[])
      : [];
    const items: NewsItem[] = results
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        source: r.meta_url?.hostname ?? r.profile?.name ?? '',
        age: r.age ?? null,
        description: r.description ?? null,
        thumbnail: r.thumbnail?.src ?? null,
      }))
      .filter((i) => i.title !== '' && i.url !== '');

    cache.set(cacheKey, { items, fetchedAt: now });
    return items;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Brave search failed');
    return cached?.items ?? null;
  } finally {
    clearTimeout(timer);
  }
}
