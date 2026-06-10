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

// Standing liveness check (shipping rule): the external fleet-watchdog catches
// a DEAD bot; this catches a LIVE bot whose reconcile is failing — i.e. Atlas
// persistently unverifiable (the 3-day-outage shape) or a suspiciously large
// reap (possible bad mass-delete). Alerts Mark's Telegram once per episode.
let consecutiveAborts = 0;
let abortAlertSent = false;
const ABORT_ALERT_AFTER = 3;     // 3 × 5min = 15min of Atlas unverifiable
const LARGE_REAP_THRESHOLD = 25; // reaping more than this at once is suspicious

async function alertMark(ctx, text) {
  const chatId = process.env.TELEGRAM_CHAT_ID || (ctx.config?.behavior?.access?.admin_users || [])[0];
  if (!chatId) { ctx.log.warn(`[reconcile-alert] no admin chat configured: ${text}`); return; }
  try { await ctx.adapter.send({ chatId, text: `🛠 Kristina sync: ${text}` }); }
  catch (err) { ctx.log.error(`[reconcile-alert] send failed: ${err}`); }
}

export default {
  name: 'sync_retry',
  async execute(ctx) {
    try {
      const rep = await reconcile(ctx);
      if (rep?.aborted) {
        consecutiveAborts++;
        ctx.log.warn(`sync_retry: reconcile aborted (${rep.aborted}) x${consecutiveAborts} — skipping retry`);
        if (consecutiveAborts >= ABORT_ALERT_AFTER && !abortAlertSent) {
          await alertMark(ctx, `reconcile has been aborting for ${consecutiveAborts} cycles (${rep.aborted}). Atlas may be unreachable — tasks won't sync until it recovers.`);
          abortAlertSent = true;
        }
        return; // don't push/act on unverifiable truth
      }
      // recovered
      if (abortAlertSent) { await alertMark(ctx, `reconcile recovered — Atlas reachable again, sync resumed.`); }
      consecutiveAborts = 0;
      abortAlertSent = false;
      if (rep?.reaped > LARGE_REAP_THRESHOLD) {
        await alertMark(ctx, `reconcile reaped ${rep.reaped} local tasks this cycle (snapshot=${rep.snapshot}). Larger than expected — check that Atlas returned the full board.`);
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
