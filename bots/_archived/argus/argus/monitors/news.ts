/**
 * Argus Trading System — News & Filings Monitor
 *
 * Low-frequency RSS feed monitor for the stock strategist.
 * Collects headlines from free financial news sources for
 * LLM consumption during quarterly rebalancing analysis.
 *
 * Sources:
 * - Finviz RSS — market news headlines
 * - Yahoo Finance RSS — stock/market news
 * - EDGAR filings — SEC 13F, 10-K, 10-Q filings
 *
 * Runs every few hours (not real-time — news is consumed in batch
 * by the stock strategist during quarterly analysis).
 */

import { getDb } from '../lib/db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MonitorContext {
  /** Send alert to configured channels */
  sendAlert: (severity: 'info' | 'warning' | 'critical', title: string, message: string) => Promise<void>;
}

interface CronHandler {
  name: string;
  execute: (ctx: MonitorContext) => Promise<void>;
}

interface NewsItem {
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  summary?: string;
}

// ─── RSS Feed Configuration ─────────────────────────────────────────────────

const RSS_FEEDS = {
  finviz: {
    name: 'Finviz',
    url: 'https://finviz.com/news_export.ashx?v=3',
    description: 'Finviz market news headlines',
  },
  yahoo: {
    name: 'Yahoo Finance',
    url: 'https://finance.yahoo.com/news/rssindex',
    description: 'Yahoo Finance top stories',
  },
  edgar: {
    name: 'EDGAR',
    url: 'https://efts.sec.gov/LATEST/search-index?q=%2213F%22&dateRange=custom&startdt=STARTDATE&enddt=ENDDATE&forms=13F-HR',
    description: 'SEC EDGAR 13F filings (institutional holdings)',
  },
} as const;

// ─── Database Schema ──────────────────────────────────────────────────────────

/**
 * The news table should be created in a future DB migration.
 * Schema:
 *
 *   CREATE TABLE IF NOT EXISTS news (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     source TEXT NOT NULL,
 *     title TEXT NOT NULL,
 *     url TEXT NOT NULL UNIQUE,
 *     published_at TEXT NOT NULL,
 *     summary TEXT,
 *     fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_news_source ON news(source, published_at);
 *   CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at);
 */

// ─── Cron Handler ─────────────────────────────────────────────────────────────

/**
 * News monitor cron handler.
 *
 * Runs every few hours (e.g. every 4-6 hours). Fetches headlines
 * from each RSS source and stores new (unseen) items in the database.
 *
 * Headlines are consumed by intelligence/stock-strategist.ts during
 * quarterly rebalancing analysis.
 */
const newsMonitor: CronHandler = {
  name: 'news_monitor',

  async execute(ctx: MonitorContext): Promise<void> {
    console.error('[news_monitor] Fetching financial news feeds');

    let totalNew = 0;
    const errors: string[] = [];

    // Fetch each RSS source
    for (const [key, feed] of Object.entries(RSS_FEEDS)) {
      try {
        const items = await fetchFeed(key, feed.url);
        const stored = await storeNewItems(items);
        totalNew += stored;
        console.error(`[news_monitor] ${feed.name}: ${stored} new items`);
      } catch (err) {
        const msg = `${feed.name} fetch failed: ${err instanceof Error ? err.message : err}`;
        errors.push(msg);
        console.error(`[news_monitor] ${msg}`);
      }
    }

    // Prune old news (keep 30 days)
    try {
      pruneOldNews();
    } catch (err) {
      console.error(`[news_monitor] Pruning failed: ${err}`);
    }

    console.error(`[news_monitor] Complete — ${totalNew} new items stored`);

    if (errors.length > 0) {
      await ctx.sendAlert(
        'info',
        `News Monitor: ${errors.length} feeds failed`,
        errors.join('\n'),
      );
    }
  },
};

export default newsMonitor;

// ─── Feed Fetchers ──────────────────────────────────────────────────────────

/**
 * Fetch and parse an RSS feed.
 *
 * @param source - Source identifier (finviz, yahoo, edgar)
 * @param url - RSS feed URL
 * @returns Array of parsed news items
 *
 * TODO: Use native fetch() to get RSS XML
 * TODO: Parse XML (use a lightweight XML parser or regex for simple RSS)
 * TODO: Extract title, link, pubDate, description from each <item>
 * TODO: For EDGAR: format URL with date range parameters
 */
async function fetchFeed(source: string, url: string): Promise<NewsItem[]> {
  console.error(`[news_monitor] Fetching ${source}: ${url}`);

  // TODO: Fetch RSS feed
  // const response = await fetch(url, {
  //   headers: { 'User-Agent': 'Argus-Trading-Bot/1.0' },
  //   signal: AbortSignal.timeout(30_000),
  // });
  // const xml = await response.text();

  // TODO: Parse RSS XML into NewsItem[]
  // Simple RSS has <item> elements with:
  //   <title>, <link>, <pubDate>, <description>

  throw new Error(`Not implemented: RSS feed parsing for ${source}`);
}

/**
 * Store new news items in the database (deduplicates by URL).
 *
 * @param items - News items to store
 * @returns Number of new items stored
 *
 * TODO: Requires news table migration (see schema above)
 */
async function storeNewItems(items: NewsItem[]): Promise<number> {
  // TODO: Implement once news table migration is applied
  // const db = getDb();
  // const insert = db.prepare(`
  //   INSERT OR IGNORE INTO news (source, title, url, published_at, summary)
  //   VALUES (?, ?, ?, ?, ?)
  // `);
  //
  // let count = 0;
  // for (const item of items) {
  //   const result = insert.run(item.source, item.title, item.url, item.publishedAt, item.summary ?? null);
  //   if (result.changes > 0) count++;
  // }
  // return count;

  throw new Error('Not implemented: news storage (requires DB migration)');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Remove news older than 30 days.
 */
function pruneOldNews(): void {
  // TODO: Implement once news table migration is applied
  // const db = getDb();
  // db.prepare(`
  //   DELETE FROM news WHERE published_at < datetime('now', '-30 days')
  // `).run();
}

/**
 * Get recent news headlines for LLM consumption.
 *
 * @param days - Number of days to look back (default: 7)
 * @param limit - Max number of items (default: 100)
 * @returns Array of news items
 */
export function getRecentNews(days: number = 7, limit: number = 100): NewsItem[] {
  // TODO: Implement once news table migration is applied
  // const db = getDb();
  // return db.prepare(`
  //   SELECT source, title, url, published_at as publishedAt, summary
  //   FROM news
  //   WHERE published_at > datetime('now', '-' || ? || ' days')
  //   ORDER BY published_at DESC
  //   LIMIT ?
  // `).all(days, limit) as NewsItem[];

  throw new Error('Not implemented: news retrieval (requires DB migration)');
}
