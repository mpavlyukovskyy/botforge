/**
 * Cron handler: sync_cleancloud
 *
 * Daily sync from CleanCloud API → local SQLite cache.
 * Runs at 6am NZST (18:00 UTC).
 */
import { syncFromAPI } from '../lib/cleancloud-api.js';
import * as db from '../lib/db.js';

export default {
  name: 'sync_cleancloud',
  async execute(ctx) {
    ctx.log.info('Starting CleanCloud sync...');

    try {
      db.ensureDb(ctx.config);
      const result = await syncFromAPI(ctx.config, db);
      ctx.log.info(`CleanCloud sync complete: ${result.products} products, ${result.sections} sections, ${result.priceLists} price lists`);
    } catch (err) {
      ctx.log.error(`CleanCloud sync failed: ${err.message}`);
    }
  },
};
