/**
 * Cron handler: deadline_expiry
 *
 * Every 15 min. For OPEN tasks whose deadline has passed but haven't been
 * notified yet, mark earned_status='OVERDUE', sync to Atlas, and DM the
 * requester with a quick "your task has slipped" prompt (one per task,
 * tracked via overdue_notified_at).
 *
 * Handed-off tasks are excluded — they keep their bounty locked until
 * either marked done or explicitly cancelled.
 */
import { ensureDb, updateItem } from '../lib/atlas-client.js';
import { computeDecayValue } from '../lib/decay.js';
import { loadAtlasPresence, shouldSkipRun } from '../lib/presence.js';
import { reconcile } from '../lib/sync.js';

export default {
  name: 'deadline_expiry',
  async execute(ctx) {
    const db = ensureDb(ctx.config);

    // Phase 0: reconcile to Atlas truth first; only an explicit abort skips
    // the run (skipped/disabled falls through to the presence backstop). RT-D3.
    const rep = await reconcile(ctx);
    if (rep?.aborted) {
      ctx.log.warn(`deadline_expiry: reconcile aborted (${rep.aborted}), skipping run`);
      return;
    }

    // Bleed-stopper backstop: don't flag/notify ghosts; don't act when unverifiable.
    const presence = await loadAtlasPresence(ctx);
    if (shouldSkipRun(presence)) {
      ctx.log.warn('deadline_expiry: Atlas unverifiable, skipping run');
      return;
    }

    // Find OPEN tasks past deadline not yet flagged
    const expired = db.prepare(
      `SELECT id, spok_id, title, deadline, requester_chat_id
         FROM tasks
        WHERE status = 'OPEN'
          AND deadline IS NOT NULL
          AND datetime(deadline) < datetime('now')
          AND (earned_status IS NULL OR earned_status NOT IN ('OVERDUE','CANCELLED','EARNED','PENALTY'))
          AND handed_off_at IS NULL
          AND overdue_notified_at IS NULL`
    ).all();

    if (expired.length === 0) return;
    ctx.log.info(`deadline_expiry: ${expired.length} tasks newly overdue`);

    for (const task of expired) {
      if (presence.skip(task)) continue;
      const { value } = computeDecayValue(task.deadline);
      db.prepare(
        `UPDATE tasks
            SET earned_status = 'OVERDUE',
                current_value = ?,
                overdue_notified_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(value, task.id);

      if (task.spok_id) {
        try {
          await updateItem(ctx, task.spok_id, { earnedStatus: 'OVERDUE' });
        } catch (err) {
          ctx.log.warn(`deadline_expiry: Atlas update failed for ${task.id}: ${err}`);
        }
      }

      // Notify the requester (best-effort — failures don't block other tasks)
      if (task.requester_chat_id) {
        try {
          await ctx.adapter.send({
            chatId: task.requester_chat_id,
            text: `⏰ Past deadline: "${task.title}" (ID:${task.id.slice(0, 8)}) — current value $${value.toFixed(2)}. Mark done or hand off?`,
          });
        } catch (err) {
          ctx.log.warn(`deadline_expiry: send failed to ${task.requester_chat_id}: ${err}`);
        }
      }
    }
  },
};
