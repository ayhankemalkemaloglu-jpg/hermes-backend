import { logger } from '../utils/logger';

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  age: string | null;
  /** Publish time in epoch ms (for sorting); null if unparseable. */
  published: number | null;
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
      const pubDate = pick(block, 'pubDate');
      const ts = pubDate ? Date.parse(pubDate) : NaN;
      items.push({
        title,
        url,
        source,
        age: relativeAge(pubDate),
        published: Number.isNaN(ts) ? null : ts,
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

/**
 * Fetch crypto news from key-free RSS feeds, merged and trimmed. Cached 5 min.
 * Returns [] only if every feed fails (and no cache) — never null.
 */
export async function fetchNews(category = 'crypto', count = 15): Promise<NewsItem[]> {
  const now = Date.now();
  const cached = cache.get(category);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.items;

  const feeds = FEEDS[category] ?? FEEDS.crypto;
  const lists = await Promise.all(feeds.map(fetchFeed));
  // Merge all feeds and sort newest → oldest by publish time (nulls last).
  const merged = lists.flat();
  merged.sort((a, b) => (b.published ?? 0) - (a.published ?? 0));

  const items = merged.slice(0, count);
  if (items.length === 0 && cached) return cached.items;
  cache.set(category, { items, fetchedAt: now });
  return items;
}
