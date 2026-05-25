import { config } from '../config';
import { logger } from '../utils/logger';

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  age: string | null;
  /** ISO publish time when known, for newest-first sorting / client dedup. */
  published_at: string | null;
  description: string | null;
  thumbnail: string | null;
}

interface Feed {
  name: string;
  url: string;
}

// Browser-like UA so feeds behind bot protection (Cloudflare) don't 403.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Key-free crypto RSS sources. Google News is the reliable always-on primary
// (open, aggregates many outlets); the others add coverage when reachable.
const FEEDS: Record<string, Feed[]> = {
  crypto: [
    {
      name: 'Google News',
      url: 'https://news.google.com/rss/search?q=cryptocurrency%20OR%20bitcoin%20OR%20ethereum%20when:1d&hl=en-US&gl=US&ceid=US:en',
    },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
    { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  ],
};

interface CacheEntry {
  items: NewsItem[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;
const TIMEOUT_MS = 6_000;

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function pick(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decode(m[1]) : null;
}

function pickThumb(block: string): string | null {
  const m =
    block.match(/<media:content[^>]*url="([^"]+)"/i) ??
    block.match(/<media:thumbnail[^>]*url="([^"]+)"/i) ??
    block.match(/<enclosure[^>]*url="([^"]+)"/i);
  return m ? m[1] : null;
}

/**
 * Best-effort parse of a date-ish string to epoch ms: handles ISO / RFC dates
 * (RSS pubDate, Brave page_age) and relative phrases ("2 hours ago", Brave's
 * `age`). Returns null when nothing parses.
 */
function parseWhen(s: string | null | undefined): number | null {
  if (!s) return null;
  const abs = Date.parse(s);
  if (!Number.isNaN(abs)) return abs;
  const rel = s.match(/(\d+)\s*(minute|min|hour|hr|day|week|month)s?\s*ago/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith('min')
      ? 60_000
      : unit.startsWith('hour') || unit.startsWith('hr')
        ? 3_600_000
        : unit.startsWith('day')
          ? 86_400_000
          : unit.startsWith('week')
            ? 604_800_000
            : 2_592_000_000; // month ≈ 30d
    return Date.now() - n * ms;
  }
  return null;
}

/** ISO string for a date-ish input, or null. */
function toIso(s: string | null | undefined): string | null {
  const ms = parseWhen(s);
  return ms === null ? null : new Date(ms).toISOString();
}

function relativeAge(pubDate: string | null): string | null {
  const t = parseWhen(pubDate);
  if (t === null) return null;
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins} dk önce`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} saat önce`;
  return `${Math.floor(hrs / 24)} gün önce`;
}

async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ feed: feed.name, status: res.status }, 'RSS fetch returned non-OK');
      return [];
    }
    const xml = await res.text();
    const items: NewsItem[] = [];
    const itemRe = /<item[\s\S]*?<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null) {
      const block = m[0];
      const rawTitle = pick(block, 'title');
      const url = pick(block, 'link');
      if (!rawTitle || !url) continue;
      // Google News carries the real outlet in <source>; otherwise use the feed.
      const source = pick(block, 'source') ?? feed.name;
      // Google News appends " - Outlet" to titles; trim that for clean cards.
      const title = rawTitle.endsWith(` - ${source}`)
        ? rawTitle.slice(0, -(source.length + 3))
        : rawTitle;
      const pubDate = pick(block, 'pubDate');
      items.push({
        title,
        url,
        source,
        age: relativeAge(pubDate),
        published_at: toIso(pubDate),
        description: pick(block, 'description'),
        thumbnail: pickThumb(block),
      });
    }
    return items;
  } catch (err) {
    logger.warn({ feed: feed.name, err: (err as Error).message }, 'RSS fetch failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Recency-biased queries for the Brave web tier (per category).
const BRAVE_QUERIES: Record<string, string> = {
  crypto: 'cryptocurrency OR bitcoin OR ethereum latest news',
};

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  profile?: { name?: string };
  meta_url?: { hostname?: string };
  thumbnail?: { src?: string };
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
  news?: { results?: BraveResult[] };
}

function mapBrave(r: BraveResult): NewsItem | null {
  const title = r.title ? decode(r.title) : null;
  if (!title || !r.url) return null;
  return {
    title,
    url: r.url,
    source: r.profile?.name ?? r.meta_url?.hostname ?? 'Brave',
    // page_age/age are ISO or relative ("2 hours ago"); both feed relativeAge.
    age: relativeAge(r.page_age ?? r.age ?? null) ?? (typeof r.age === 'string' ? r.age : null),
    published_at: toIso(r.page_age) ?? toIso(r.age),
    description: r.description ? decode(r.description) : null,
    thumbnail: r.thumbnail?.src ?? null,
  };
}

/**
 * Brave Search (web tier) news, used when BRAVE_API_KEY is set. We send no
 * `freshness` filter on purpose — on the free web tier it zeroes results — and
 * instead lean on a recency-biased query and the news cluster Brave returns.
 * Returns [] on any failure so the caller can fall back to RSS.
 */
async function fetchBrave(category: string, count: number): Promise<NewsItem[]> {
  const key = config.BRAVE_API_KEY;
  if (!key) return [];

  const q = BRAVE_QUERIES[category] ?? BRAVE_QUERIES.crypto;
  const url =
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}` +
    `&count=${Math.min(count, 20)}&country=us&search_lang=en&spellcheck=0`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Brave news fetch returned non-OK');
      return [];
    }
    const data = (await res.json()) as BraveResponse;
    // News cluster + generic web results; fetchNews sorts and de-dups.
    const raw = [...(data.news?.results ?? []), ...(data.web?.results ?? [])];
    return raw.map(mapBrave).filter((x): x is NewsItem => x !== null);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Brave news fetch failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** All items from the key-free RSS feeds (fetchNews sorts and de-dups). */
async function fetchRss(category: string): Promise<NewsItem[]> {
  const feeds = FEEDS[category] ?? FEEDS.crypto;
  const lists = await Promise.all(feeds.map(fetchFeed));
  return lists.flat();
}

function whenMs(iso: string | null): number {
  if (!iso) return -Infinity;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Newest-first, de-duplicated by URL, trimmed to `count`. Undated items last. */
function sortAndDedup(items: NewsItem[], count: number): NewsItem[] {
  const sorted = [...items].sort((a, b) => whenMs(b.published_at) - whenMs(a.published_at));
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of sorted) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out.slice(0, count);
}

/**
 * Crypto news, cached for TTL_MS, returned newest-first and de-duplicated by
 * URL. Prefers the Brave API when BRAVE_API_KEY is set, falling back to
 * key-free RSS when Brave is unset, fails, or is empty. Returns [] only if
 * every source fails and there's no cache — never null.
 */
export async function fetchNews(category = 'crypto', count = 15): Promise<NewsItem[]> {
  const now = Date.now();
  const cached = cache.get(category);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.items;

  let raw = await fetchBrave(category, count);
  if (raw.length === 0) raw = await fetchRss(category);
  const items = sortAndDedup(raw, count);

  if (items.length === 0 && cached) return cached.items;
  cache.set(category, { items, fetchedAt: now });
  return items;
}
