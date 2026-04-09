/**
 * Lifecycle hook: start
 *
 * Runs lunch DB migrations, task DB migrations, and pre-warms column cache.
 */
import { runMigrations } from '../lib/db.js';
import { runMigrations as runTaskMigrations } from '../lib/task-db.js';
import { ensureDb, getColumns } from '../lib/atlas-client.js';

export default {
  event: 'start',
  async execute(ctx) {
    // Lunch DB
    runMigrations(ctx);

    // Task DB (creates tables in atlas-client's ensureDb)
    ensureDb(ctx.config);
    runTaskMigrations(ctx);
    ctx.log.info('Alfred DB migrations complete');

    // Pre-warm column cache
    try {
      const columns = await getColumns(ctx);
      ctx.log.info(`Column cache warmed: ${columns.length} columns`);
    } catch (err) {
      ctx.log.warn(`Column cache warm-up failed: ${err}`);
    }

    ctx.log.info('Alfred started');
  },
};
