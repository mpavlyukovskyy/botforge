/**
 * Context builder: lunch_state
 *
 * Injects current lunch recommendation state into LLM context.
 */
import { ensureDb, getCurrentWeekOf, getRecommendationsForWeek, getMenuForWeek } from '../lib/db.js';

export default {
  type: 'lunch_state',
  async build(ctx) {
    let db;
    try {
      db = ensureDb(ctx.config);
    } catch {
      return '';
    }

    const weekOf = getCurrentWeekOf();

    try {
      const recs = getRecommendationsForWeek(ctx.config, weekOf);
      const menu = getMenuForWeek(ctx.config, weekOf);

      if (recs.length > 0) {
        const days = [...new Set(recs.map(r => r.day))];
        return `<lunch_this_week>${recs.length} recommendations across ${days.length} day(s): ${days.join(', ')}. Week of ${weekOf}. Use get_recommendations tool for details.</lunch_this_week>`;
      }

      if (menu.length > 0) {
        return `<lunch_this_week>Menu scraped (${menu.length} items) but not yet analyzed. Week of ${weekOf}. Use get_menu tool or suggest /refresh to run analysis.</lunch_this_week>`;
      }

      return '<lunch_this_week>No menu data for this week yet. Suggest /refresh to scrape and analyze.</lunch_this_week>';
    } catch {
      return '<lunch_this_week>Lunch data unavailable.</lunch_this_week>';
    }
  },
};
