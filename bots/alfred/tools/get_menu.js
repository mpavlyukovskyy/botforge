/**
 * Brain tool: get_menu
 *
 * Query the scraped LunchDrop menu for the current week.
 */
import { z } from 'zod';
import { ensureDb, getCurrentWeekOf, getMenuForWeek } from '../lib/db.js';
import { formatMenu } from '../lib/formatter.js';

export default {
  name: 'get_menu',
  description:
    'Get the LunchDrop lunch menu for the current week. Optionally filter by day (e.g. "Monday").',
  schema: {
    day: z.string().optional().describe('Day of the week to filter by (e.g. "Monday", "Tuesday")'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch (err) {
      return 'Menu database not available. Try /refresh to scrape the menu.';
    }

    const weekOf = getCurrentWeekOf();
    const day = args.day ? args.day.charAt(0).toUpperCase() + args.day.slice(1).toLowerCase() : null;
    const items = getMenuForWeek(ctx.config, weekOf, day);

    if (items.length === 0) {
      return day
        ? `No menu items found for ${day} (week of ${weekOf}). The menu may not be scraped yet — try /refresh.`
        : `No menu items found for the week of ${weekOf}. Try /refresh to scrape the menu.`;
    }

    return formatMenu(items, day);
  },
};
