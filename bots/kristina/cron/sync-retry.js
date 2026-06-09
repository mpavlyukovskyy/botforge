/**
 * Cron handler: sync_retry
 *
 * (1) Reconcile: pull full Atlas truth → make the local cache equal it (reap
 *     ghosts, learn dashboard-created tasks, heal links). This is the spine of
 *     the Atlas-as-source-of-truth fix — runs every 5 min so local never drifts.
 * (2) Retry: push any not-yet-synced local creates to Atlas (idempotent via
 *     externalId).
 *
 * Order matters: reconcile first (so retry doesn't re-push something Atlas
 * already has under a different id — externalId makes that safe regardless).
 */
import { retrySyncPending } from '../lib/atlas-client.js';
import { reconcile } from '../lib/sync.js';

export default {
  name: 'sync_retry',
  async execute(ctx) {
    try {
      const rep = await reconcile(ctx);
      if (rep?.aborted) {
        ctx.log.warn(`sync_retry: reconcile aborted (${rep.aborted}) — skipping retry this cycle`);
        return; // don't push/act on unverifiable truth
      }
    } catch (err) {
      ctx.log.error(`Reconcile failed: ${err}`);
      return;
    }
    try {
      const count = await retrySyncPending(ctx);
      if (count > 0) ctx.log.info(`Sync retry: ${count} items synced`);
    } catch (err) {
      ctx.log.error(`Sync retry failed: ${err}`);
    }
  },
};
