/**
 * Cron handler: auto_archive
 *
 * Archives DONE items >24h and OPEN overdue items >14 days.
 */
import { ensureDb, updateItem } from '../lib/atlas-client.js';

export default {
  name: 'auto_archive',
  async execute(ctx) {
    const db = ensureDb(ctx.config);

    // Archive DONE items older than 24h
    const doneItems = db.prepare(
      "SELECT id, spok_id FROM tasks WHERE status = 'DONE' AND updated_at < datetime('now', '-24 hours')"
    ).all();

    for (const item of doneItems) {
      db.prepare("UPDATE tasks SET status = 'ARCHIVED', updated_at = datetime('now') WHERE id = ?").run(item.id);
      if (item.spok_id) {
        try { await updateItem(ctx, item.spok_id, { status: 'ARCHIVED' }); } catch {}
      }
    }

    // Archive OPEN overdue items older than 14 days
    const overdueItems = db.prepare(
      "SELECT id, spok_id FROM tasks WHERE status = 'OPEN' AND deadline IS NOT NULL AND deadline < date('now', '-14 days')"
    ).all();

    for (const item of overdueItems) {
      db.prepare("UPDATE tasks SET status = 'ARCHIVED', updated_at = datetime('now') WHERE id = ?").run(item.id);
      if (item.spok_id) {
        try { await updateItem(ctx, item.spok_id, { status: 'ARCHIVED' }); } catch {}
      }
    }

    const total = doneItems.length + overdueItems.length;
    if (total > 0) ctx.log.info(`Auto-archived ${total} items`);
  },
};
