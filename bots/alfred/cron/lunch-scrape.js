/**
 * Cron handler: lunch_scrape
 *
 * Runs every Sunday at 6pm ET.
 * Pipeline: scrape LunchDrop → store menu → run 3-agent analysis → store recs → send to group.
 */
import { ensureDb, storeMenuItems, storeRecommendations, logScrape, getCurrentWeekOf } from '../lib/db.js';
import { analyzeMenu } from '../lib/analysis.js';
import { formatRecommendations } from '../lib/formatter.js';

let _running = false;

export default {
  name: 'lunch_scrape',
  async execute(ctx) {
    // Re-entrancy guard
    if (_running) {
      ctx.log.info('lunch_scrape: skipping, already running');
      return;
    }
    _running = true;

    const groupChatId = process.env.LUNCH_GROUP_CHAT_ID;
    const budget = parseInt(process.env.DAILY_BUDGET || '20', 10);

    try {
      const db = ensureDb(ctx.config);

      // ── Step 1: Scrape ────────────────────────────────────────────────────
      ctx.log.info('lunch_scrape: starting menu scrape');
      const { scrapeMenu } = await import('../lib/scraper.js');
      let scrapeResult;
      try {
        scrapeResult = await scrapeMenu(ctx.log);
      } catch (err) {
        ctx.log.error(`lunch_scrape: scrape failed — ${err.message}`);
        logScrape(ctx.config, getCurrentWeekOf(), 'error', 0, err.message);

        if (groupChatId) {
          await ctx.adapter.send({
            chatId: groupChatId,
            text: '⚠️ LunchDrop menu scrape failed this week. Use /refresh to retry manually.',
          });
        }
        return;
      }

      if (!scrapeResult || scrapeResult.items.length === 0) {
        ctx.log.warn('lunch_scrape: no menu items found');
        logScrape(ctx.config, getCurrentWeekOf(), 'empty', 0, 'No items found');

        if (groupChatId) {
          await ctx.adapter.send({
            chatId: groupChatId,
            text: '📋 No LunchDrop menus posted yet for next week. I\'ll try again, or use /refresh later.',
          });
        }
        return;
      }

      // ── Step 2: Store menu ────────────────────────────────────────────────
      const weekOf = scrapeResult.weekOf;
      storeMenuItems(ctx.config, weekOf, scrapeResult.items);
      logScrape(ctx.config, weekOf, 'success', scrapeResult.items.length);
      ctx.log.info(`lunch_scrape: stored ${scrapeResult.items.length} items for week of ${weekOf}`);

      // ── Step 3: Analyze ───────────────────────────────────────────────────
      ctx.log.info('lunch_scrape: running 3-agent analysis');
      let recommendations;
      try {
        recommendations = await analyzeMenu(scrapeResult.items, budget);
      } catch (err) {
        ctx.log.error(`lunch_scrape: analysis failed — ${err.message}`);
        if (groupChatId) {
          await ctx.adapter.send({
            chatId: groupChatId,
            text: `📋 Menu scraped (${scrapeResult.items.length} items) but analysis failed. Use /refresh to retry.`,
          });
        }
        return;
      }

      // ── Step 4: Store recommendations ─────────────────────────────────────
      if (recommendations.length > 0) {
        storeRecommendations(ctx.config, weekOf, recommendations);
        ctx.log.info(`lunch_scrape: stored ${recommendations.length} recommendations`);
      }

      // ── Step 5: Send to group ─────────────────────────────────────────────
      if (groupChatId && recommendations.length > 0) {
        const messages = formatRecommendations(recommendations, weekOf);
        for (const text of messages) {
          await ctx.adapter.send({
            chatId: groupChatId,
            text,
            parseMode: 'Markdown',
          });
        }

        // Mark as sent
        const db2 = ensureDb(ctx.config);
        db2.prepare(
          'UPDATE lunch_recommendations SET sent_at = datetime(\'now\') WHERE week_of = ?'
        ).run(weekOf);

        ctx.log.info('lunch_scrape: recommendations sent to group');
      } else if (!groupChatId) {
        ctx.log.warn('lunch_scrape: LUNCH_GROUP_CHAT_ID not set, skipping send');
      }
    } finally {
      _running = false;
    }
  },
};
