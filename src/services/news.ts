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

function relativeAge(pubDate: string | null): string | null {
  if (!pubDate) return null;
  const t = new Date(pubDate).getTime();
  if (Number.isNaN(t)) return null;
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
      items.push({
        title,
        url,
        source,
        age: relativeAge(pick(block, 'pubDate')),
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
    // page_age is ISO (→ relative); otherwise Brave's own "2 hours ago" string.
    age: relativeAge(r.page_age ?? null) ?? (typeof r.age === 'string' ? r.age : null),
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
    // The news cluster (when present) is fresher than generic web results.
    const raw = [...(data.news?.results ?? []), ...(data.web?.results ?? [])];
    const seen = new Set<string>();
    const items: NewsItem[] = [];
    for (const r of raw) {
      const item = mapBrave(r);
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
    return items.slice(0, count);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Brave news fetch failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Merge the key-free RSS feeds, interleaved so no single source dominates. */
async function fetchRss(category: string, count: number): Promise<NewsItem[]> {
  const feeds = FEEDS[category] ?? FEEDS.crypto;
  const lists = await Promise.all(feeds.map(fetchFeed));
  const merged: NewsItem[] = [];
  const max = Math.max(...lists.map((l) => l.length), 0);
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      if (list[i]) merged.push(list[i]);
    }
  }
  return merged.slice(0, count);
}

/**
 * Crypto news, cached for TTL_MS. Prefers the Brave API when BRAVE_API_KEY is
 * set, falling back to key-free RSS when Brave is unset, fails, or is empty.
 * Returns [] only if every source fails and there's no cache — never null.
 */
export async function fetchNews(category = 'crypto', count = 15): Promise<NewsItem[]> {
  const now = Date.now();
  const cached = cache.get(category);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.items;

  let items = await fetchBrave(category, count);
  if (items.length === 0) items = await fetchRss(category, count);

  if (items.length === 0 && cached) return cached.items;
  cache.set(category, { items, fetchedAt: now });
  return items;
}
