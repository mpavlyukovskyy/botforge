/**
 * Cron handler: sync_retry
 *
 * Retries syncing locally-created tasks that failed to reach Atlas.
 */
import { retrySyncPending } from '../lib/atlas-client.js';

export default {
  name: 'sync_retry',
  async execute(ctx) {
    try {
      const count = await retrySyncPending(ctx);
      if (count > 0) ctx.log.info(`Sync retry: ${count} items synced`);
    } catch (err) {
      ctx.log.error(`Sync retry failed: ${err}`);
    }
  },
};
