/**
 * Cron handler: decay_check
 *
 * Every 15 min. For OVERDUE tasks, recompute the decaying value and notify
 * the requester at threshold crossings ($0.10, $0.00, then once per
 * additional negative session). Stops notifying after 5 prompts per task
 * to avoid spam.
 *
 * Notifications are tracked via the `notified_at` column (stores the last
 * threshold notified, e.g. "0.10", "0.00", "-0.50").
 *
 * Source: standalone src/scheduler/cron.ts decay check + commit 8128e6c
 * (don't re-notify DONE/ARCHIVED tasks).
 */
import { ensureDb, updateItem } from '../lib/atlas-client.js';
import { computeDecayValue } from '../lib/decay.js';
import { loadAtlasPresence, shouldSkipRun } from '../lib/presence.js';
import { reconcile } from '../lib/sync.js';

const NOTIFY_THRESHOLDS = [0.10, 0.0, -1.0, -2.0, -3.0];

export default {
  name: 'decay_check',
  async execute(ctx) {
    const db = ensureDb(ctx.config);

    // Phase 0: make the local cache equal Atlas truth BEFORE acting on money.
    // Only an explicit abort (Atlas unverifiable) skips the run; a 'skipped'
    // result (another reconcile already running / disabled) falls through to the
    // presence guard below (belt-and-suspenders). See red-team D3.
    const rep = await reconcile(ctx);
    if (rep?.aborted) {
      ctx.log.warn(`decay_check: reconcile aborted (${rep.aborted}), skipping run`);
      return;
    }

    // Bleed-stopper backstop: never decay/notify a task Atlas no longer has,
    // and don't act when Atlas can't be verified. See lib/presence.js.
    const presence = await loadAtlasPresence(ctx);
    if (shouldSkipRun(presence)) {
      ctx.log.warn('decay_check: Atlas unverifiable, skipping run');
      return;
    }

    const tasks = db.prepare(
      `SELECT id, spok_id, title, deadline, current_value, notified_at, requester_chat_id
         FROM tasks
        WHERE status = 'OPEN'
          AND earned_status = 'OVERDUE'
          AND deadline IS NOT NULL
          AND handed_off_at IS NULL`
    ).all();

    for (const task of tasks) {
      if (presence.skip(task)) continue;
      const { value } = computeDecayValue(task.deadline);

      // Update value if it has dropped
      if (value !== task.current_value) {
        db.prepare("UPDATE tasks SET current_value = ?, updated_at = datetime('now') WHERE id = ?")
          .run(value, task.id);
      }

      // Find next un-notified threshold this value has crossed
      const lastNotified = task.notified_at ? parseFloat(task.notified_at) : Number.POSITIVE_INFINITY;
      const newThreshold = NOTIFY_THRESHOLDS.find(t => value <= t && t < lastNotified);
      if (newThreshold === undefined) continue;

      if (task.requester_chat_id) {
        // Embed a resolvable id (matches board ID:<prefix>) so a reply like
        // "done" resolves to THIS task instead of a fuzzy title match — the
        // coherence gap behind "I can't find that task" (incident 2026-06-09).
        const ref = `(ID:${(task.spok_id || task.id).slice(0, 8)})`;
        try {
          await ctx.adapter.send({
            chatId: task.requester_chat_id,
            text:
              newThreshold > 0
                ? `⚠️ "${task.title}" ${ref} is at $${value.toFixed(2)} (was worth $1.00). Mark done soon.`
                : newThreshold === 0
                  ? `❌ "${task.title}" ${ref} hit $0.00. Past this point it goes negative.`
                  : `📉 "${task.title}" ${ref} at -$${Math.abs(value).toFixed(2)}. Consider cancelling or handing off.`,
          });
        } catch (err) {
          ctx.log.warn(`decay_check: send failed to ${task.requester_chat_id}: ${err}`);
        }
      }

      db.prepare("UPDATE tasks SET notified_at = ?, updated_at = datetime('now') WHERE id = ?")
        .run(String(newThreshold), task.id);

      if (task.spok_id) {
        try { await updateItem(ctx, task.spok_id, { currentValue: value }); } catch {}
      }
    }
  },
};
