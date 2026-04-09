/**
 * Command: /refresh
 *
 * Manually trigger LunchDrop scrape + analysis and send results.
 * Cache-aware: uses stored menu/recs when available.
 * /refresh force — bypasses cache and always scrapes.
 */
import {
  ensureDb, storeMenuItems, storeRecommendations, logScrape,
  getCurrentWeekOf, getMenuForWeek, getRecommendationsForWeek,
  dbMenuToAnalysisFormat,
} from '../lib/db.js';
import { analyzeMenu } from '../lib/analysis.js';
import { formatRecommendations } from '../lib/formatter.js';

export default {
  command: 'refresh',
  description: 'Scrape LunchDrop menu and generate fresh recommendations',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    const budget = parseInt(process.env.DAILY_BUDGET || '20', 10);
    const force = args && args.trim().toLowerCase() === 'force';

    try {
      ensureDb(ctx.config);
    } catch (err) {
      await ctx.adapter.send({ chatId, text: '❌ Database not available.' });
      return;
    }

    const weekOf = getCurrentWeekOf();

    // ── Cache check (skip if force) ──────────────────────────────────────────
    if (!force) {
      const existingMenu = getMenuForWeek(ctx.config, weekOf);
      if (existingMenu.length > 0) {
        let recs = getRecommendationsForWeek(ctx.config, weekOf);

        if (recs.length === 0) {
          // Menu cached but no recs yet — run analysis on cached menu
          await ctx.adapter.send({
            chatId,
            text: `📋 Menu cached (${existingMenu.length} items). Running health analysis...`,
          });

          try {
            const analysisItems = dbMenuToAnalysisFormat(existingMenu);
            recs = await analyzeMenu(analysisItems, budget);
            if (recs.length > 0) {
              storeRecommendations(ctx.config, weekOf, recs);
            }
          } catch (err) {
            await ctx.adapter.send({
              chatId,
              text: `📋 Menu cached but analysis failed: ${err.message}`,
            });
            return;
          }
        }

        if (recs.length > 0) {
          const messages = formatRecommendations(recs, weekOf);
          for (const text of messages) {
            await ctx.adapter.send({ chatId, text, parseMode: 'Markdown' });
          }
          return;
        }

        // Analysis returned 0 recs (all combos over budget)
        await ctx.adapter.send({
          chatId,
          text: `📋 Menu cached (${existingMenu.length} items) but no combos fit under $${budget} budget. Use /refresh force to re-scrape.`,
        });
        return;
      }
    }

    // ── Full scrape (no cache hit or force) ──────────────────────────────────
    await ctx.adapter.send({
      chatId,
      text: '🔄 Scraping LunchDrop menu...',
    });

    const { scrapeMenu } = await import('../lib/scraper.js');
    let scrapeResult;
    try {
      scrapeResult = await scrapeMenu(ctx.log);
    } catch (err) {
      logScrape(ctx.config, getCurrentWeekOf(), 'error', 0, err.message);
      await ctx.adapter.send({
        chatId,
        text: `❌ Scrape failed: ${err.message}\nCheck /tmp/alfred-debug/ for screenshots.`,
      });
      return;
    }

    if (!scrapeResult || scrapeResult.items.length === 0) {
      logScrape(ctx.config, getCurrentWeekOf(), 'empty', 0, 'No items found');
      await ctx.adapter.send({
        chatId,
        text: '📋 No menu items found on LunchDrop. The menu may not be posted yet.',
      });
      return;
    }

    // Store menu
    const scrapeWeekOf = scrapeResult.weekOf;
    storeMenuItems(ctx.config, scrapeWeekOf, scrapeResult.items);
    logScrape(ctx.config, scrapeWeekOf, 'success', scrapeResult.items.length);

    await ctx.adapter.send({
      chatId,
      text: `✅ Scraped ${scrapeResult.items.length} items. Running health analysis...`,
    });

    // Analyze
    let recommendations;
    try {
      recommendations = await analyzeMenu(scrapeResult.items, budget);
    } catch (err) {
      await ctx.adapter.send({
        chatId,
        text: `📋 Menu scraped but analysis failed: ${err.message}`,
      });
      return;
    }

    // Store recommendations
    if (recommendations.length > 0) {
      storeRecommendations(ctx.config, scrapeWeekOf, recommendations);
    }

    // Send formatted recommendations
    if (recommendations.length > 0) {
      const messages = formatRecommendations(recommendations, scrapeWeekOf);
      for (const text of messages) {
        await ctx.adapter.send({
          chatId,
          text,
          parseMode: 'Markdown',
        });
      }
    } else {
      await ctx.adapter.send({
        chatId,
        text: `⚠️ Analysis completed but no combos fit under $${budget} budget.`,
      });
    }
  },
};
