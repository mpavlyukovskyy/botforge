/**
 * Brain tool: refresh_menu
 *
 * Manually trigger a scrape + analysis cycle.
 */
import { z } from 'zod';
import { ensureDb, storeMenuItems, storeRecommendations, getMenuForWeek, getRecommendationsForWeek, dbMenuToAnalysisFormat, logScrape, getCurrentWeekOf } from '../lib/db.js';
import { analyzeMenu } from '../lib/analysis.js';

export default {
  name: 'refresh_menu',
  description:
    'Trigger a LunchDrop menu scrape and/or AI analysis. Modes: (1) no args = use cached data if available, (2) force=true = re-scrape from LunchDrop + re-analyze, (3) reanalyze=true = keep cached menu but re-run the 3-agent health analysis. Use reanalyze when user wants to "rescore", "reanalyze", or "run analysis again". Use force when user wants to "scrape again" or "get fresh menu".',
  schema: {
    force: z.boolean().optional().describe('Force re-scrape even if data exists'),
    reanalyze: z.boolean().optional().describe('Re-run health analysis on cached menu without re-scraping'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch (err) {
      return 'Database not available. Bot may need restart.';
    }

    const budget = parseInt(process.env.DAILY_BUDGET || '20', 10);
    const weekOf = getCurrentWeekOf();

    // Check cache
    const existingMenu = getMenuForWeek(ctx.config, weekOf);

    // Reanalyze: keep cached menu, re-run 3-agent analysis
    if (args.reanalyze) {
      if (existingMenu.length === 0) {
        return 'No cached menu to reanalyze. Say "scrape the menu" to fetch fresh data from LunchDrop.';
      }
      const menuForAnalysis = dbMenuToAnalysisFormat(existingMenu);
      let recommendations;
      try {
        recommendations = await analyzeMenu(menuForAnalysis, budget);
      } catch (err) {
        return `Reanalysis failed on ${existingMenu.length} cached items: ${err.message}`;
      }
      if (recommendations.length > 0) {
        storeRecommendations(ctx.config, weekOf, recommendations);
      }
      return `Reanalyzed ${existingMenu.length} cached menu items → ${recommendations.length} new picks for week of ${weekOf}.`;
    }

    if (existingMenu.length > 0 && !args.force) {
      const existingRecs = getRecommendationsForWeek(ctx.config, weekOf);
      if (existingRecs.length > 0) {
        const days = [...new Set(existingRecs.map(r => r.day))].length;
        return `Menu already scraped for week of ${weekOf} (${existingMenu.length} items, ${existingRecs.length} picks across ${days} days). Ask me what to eat, or say "force refresh" to re-scrape.`;
      }
      // Menu exists but no recs → re-run analysis on cached data
      const menuForAnalysis = dbMenuToAnalysisFormat(existingMenu);
      let recommendations;
      try {
        recommendations = await analyzeMenu(menuForAnalysis, budget);
      } catch (err) {
        return `Cached menu found (${existingMenu.length} items) but analysis failed: ${err.message}`;
      }
      if (recommendations.length > 0) {
        storeRecommendations(ctx.config, weekOf, recommendations);
      }
      return `Generated ${recommendations.length} picks from cached menu (week of ${weekOf}).`;
    }

    // Full scrape (no cache or force=true)
    const { scrapeMenu } = await import('../lib/scraper.js');
    let scrapeResult;
    try {
      scrapeResult = await scrapeMenu(ctx.log);
    } catch (err) {
      logScrape(ctx.config, getCurrentWeekOf(), 'error', 0, err.message);
      return `Scrape failed: ${err.message}. Check /tmp/alfred-debug/ for screenshots.`;
    }

    if (!scrapeResult || scrapeResult.items.length === 0) {
      logScrape(ctx.config, getCurrentWeekOf(), 'empty', 0, 'No items found');
      return 'No menu items found on LunchDrop. The menu may not be posted yet.';
    }

    // Store menu
    storeMenuItems(ctx.config, scrapeResult.weekOf, scrapeResult.items);
    logScrape(ctx.config, scrapeResult.weekOf, 'success', scrapeResult.items.length);

    // Analyze
    let recommendations;
    try {
      recommendations = await analyzeMenu(scrapeResult.items, budget);
    } catch (err) {
      return `Menu scraped (${scrapeResult.items.length} items for week of ${scrapeResult.weekOf}) but analysis failed: ${err.message}`;
    }

    // Store recommendations
    if (recommendations.length > 0) {
      storeRecommendations(ctx.config, scrapeResult.weekOf, recommendations);
    }

    return `Refreshed! Scraped ${scrapeResult.items.length} menu items and generated ${recommendations.length} recommendations for the week of ${scrapeResult.weekOf}.`;
  },
};
