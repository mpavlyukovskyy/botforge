/**
 * Brain tool: get_recommendations
 *
 * Query AI-scored lunch recommendations for the current week.
 */
import { z } from 'zod';
import { ensureDb, getCurrentWeekOf, getRecommendationsForWeek } from '../lib/db.js';
import { formatRecommendations } from '../lib/formatter.js';

export default {
  name: 'get_recommendations',
  description:
    'Get AI-scored lunch recommendations for the current week with nutrition and longevity scores. Optionally filter by day.',
  schema: {
    day: z.string().optional().describe('Day of the week to filter by (e.g. "Monday", "Tuesday")'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch (err) {
      return 'Recommendations database not available. Try /refresh to scrape and analyze the menu.';
    }

    const weekOf = getCurrentWeekOf();
    const day = args.day ? args.day.charAt(0).toUpperCase() + args.day.slice(1).toLowerCase() : null;
    const recs = getRecommendationsForWeek(ctx.config, weekOf, day);

    if (recs.length === 0) {
      return day
        ? `No recommendations found for ${day} (week of ${weekOf}). Try /refresh to run analysis.`
        : `No recommendations found for the week of ${weekOf}. Try /refresh to scrape and analyze.`;
    }

    const messages = formatRecommendations(recs, weekOf);
    return messages.join('\n\n');
  },
};
