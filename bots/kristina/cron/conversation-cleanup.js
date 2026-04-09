/**
 * Cron handler: conversation_cleanup
 *
 * Deletes stale conversation history, callback tracking, message refs, and
 * unconfirmed PENDING tasks.
 */
import { ensureDb } from '../lib/atlas-client.js';

export default {
  name: 'conversation_cleanup',
  async execute(ctx) {
    const db = ensureDb(ctx.config);
    let cleaned = 0;

    // Delete old conversation history (>30 days)
    const r1 = db.prepare("DELETE FROM conversation_history WHERE created_at < datetime('now', '-30 days')").run();
    cleaned += r1.changes;

    // Delete stale callback tracking (>48h)
    const r2 = db.prepare("DELETE FROM callback_tracking WHERE created_at < datetime('now', '-48 hours')").run();
    cleaned += r2.changes;

    // Delete old message refs (>7 days)
    const r3 = db.prepare("DELETE FROM message_refs WHERE created_at < datetime('now', '-7 days')").run();
    cleaned += r3.changes;

    // Delete unconfirmed PENDING tasks (>48h)
    const r4 = db.prepare("DELETE FROM tasks WHERE status = 'PENDING' AND created_at < datetime('now', '-48 hours')").run();
    cleaned += r4.changes;

    if (cleaned > 0) ctx.log.info(`Cleanup: removed ${cleaned} stale records`);
  },
};
