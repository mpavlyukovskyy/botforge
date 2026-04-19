/**
 * Brain tool: refresh_cache
 *
 * Trigger a full sync from CleanCloud API to local cache.
 */
import { z } from 'zod';
import { syncFromAPI } from '../lib/cleancloud-api.js';
import * as db from '../lib/db.js';

export default {
  name: 'refresh_cache',
  description: 'Sync product and section data from CleanCloud API into the local cache. Use this when data seems stale or after making changes outside the bot.',
  schema: {},
  async execute(args, ctx) {
    try {
      db.ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    try {
      const result = await syncFromAPI(ctx.config, db);
      return `Cache refreshed: ${result.products} products, ${result.sections} sections, ${result.priceLists} price lists synced.`;
    } catch (err) {
      return `Sync failed: ${err.message}`;
    }
  },
};
