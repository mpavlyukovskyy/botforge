/**
 * Cron handler: done_notification
 *
 * Polls Atlas for items marked DONE from the dashboard and notifies
 * the requester via Telegram.
 */
import { getItems, ensureDb } from '../lib/atlas-client.js';

export default {
  name: 'done_notification',
  async execute(ctx) {
    const db = ensureDb(ctx.config);

    try {
      const atlasItems = await getItems(ctx, { status: 'DONE' });

      for (const item of atlasItems) {
        // Check if we already know about this
        const local = item.id ? db.prepare(
          "SELECT id, status, notified_at, requester_chat_id FROM tasks WHERE spok_id = ?"
        ).get(item.id) : null;

        if (!local) continue; // Unknown task
        if (local.notified_at) continue; // Already notified
        if (local.status === 'DONE') {
          // Already done locally, just mark notified
          db.prepare("UPDATE tasks SET notified_at = datetime('now') WHERE id = ?").run(local.id);
          continue;
        }

        // Task was marked done from dashboard -- notify user
        db.prepare("UPDATE tasks SET status = 'DONE', notified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(local.id);

        if (local.requester_chat_id) {
          try {
            await ctx.adapter.send({
              chatId: local.requester_chat_id,
              text: `\u2713 "${item.title}" was marked done from the dashboard.`,
            });
          } catch (err) {
            ctx.log.warn(`Failed to send done notification: ${err}`);
          }
        }
      }
    } catch (err) {
      ctx.log.error(`Done notification check failed: ${err}`);
    }
  },
};
