/**
 * Cron handler: conversation_cleanup
 *
 * Deletes stale conversation history, callback tracking, message refs, and
 * unconfirmed PENDING tasks.
 *
 * Robustness (2026-06-14): this handler was ported from the standalone taskbot,
 * which keeps all of these tables in one DB. In the botforge bot, the tools DB
 * (`<name>-tools.db`) does NOT contain `conversation_history` (that table is
 * owned by the conversation-history skill in a separate DB). The old code ran
 * `DELETE FROM conversation_history` first and threw `no such table`, aborting
 * the WHOLE cron every night — so callback_tracking / message_refs / stale
 * PENDING tasks were never cleaned either. Now each sweep is guarded by a
 * table-existence check and isolated, so a missing/absent table is skipped, not
 * fatal.
 */
import { ensureDb } from '../lib/atlas-client.js';

function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

export default {
  name: 'conversation_cleanup',
  async execute(ctx) {
    const db = ensureDb(ctx.config);
    let cleaned = 0;

    const sweep = (table, sql) => {
      if (!tableExists(db, table)) return; // table not in this DB — skip silently
      try {
        cleaned += db.prepare(sql).run().changes;
      } catch (err) {
        ctx.log.warn(`Cleanup skipped ${table}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    sweep('conversation_history', "DELETE FROM conversation_history WHERE created_at < datetime('now', '-30 days')");
    sweep('callback_tracking', "DELETE FROM callback_tracking WHERE created_at < datetime('now', '-48 hours')");
    sweep('message_refs', "DELETE FROM message_refs WHERE created_at < datetime('now', '-7 days')");
    sweep('tasks', "DELETE FROM tasks WHERE status = 'PENDING' AND created_at < datetime('now', '-48 hours')");

    if (cleaned > 0) ctx.log.info(`Cleanup: removed ${cleaned} stale records`);
  },
};
