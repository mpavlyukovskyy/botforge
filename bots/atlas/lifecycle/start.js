/**
 * Lifecycle hook: start
 *
 * Runs DB migrations and pre-warms column cache with fundId.
 * No auto-register — Atlas is a shared group bot.
 */
import { runMigrations } from '../lib/db.js';
import { getColumns, getItems, syncItemsToLocal } from '../lib/spok-client.js';

export default {
  event: 'start',
  async execute(ctx) {
    // Run DB migrations
    runMigrations(ctx);
    ctx.log.info('DB migrations complete');

    // Pre-warm column cache
    try {
      const columns = await getColumns(ctx);
      ctx.log.info(`Column cache warmed: ${columns.length} columns`);
    } catch (err) {
      ctx.log.warn(`Column cache warm-up failed: ${err}`);
    }

    // Seed local DB from remote API (all statuses, not just OPEN)
    try {
      const items = await getItems(ctx);
      syncItemsToLocal(ctx, items);
      ctx.log.info(`Local DB seeded: ${items.length} items from Spok`);
    } catch (err) {
      ctx.log.warn(`Local DB seed failed: ${err}`);
    }
  },
};
