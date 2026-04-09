/**
 * Cron handler: commitment_check
 *
 * Background maintenance job that updates overdue commitments and flags
 * items needing follow-up. Weekdays at 8am ET (before morning briefing).
 * Does not send messages — morning briefing handles display.
 */
import { getOverdue, getNeedingFollowup, listCommitments } from '../lib/commitments-db.js';
import { ensureDb } from '../lib/db.js';

export default {
  name: 'commitment_check',
  async execute(ctx) {
    const db = ensureDb(ctx.config);

    // Find active commitments that are now past due
    const today = new Date().toISOString().slice(0, 10);
    const newlyOverdue = db.prepare(`
      SELECT id, title FROM commitments
      WHERE status = 'active'
        AND due_date IS NOT NULL
        AND due_date < ?
    `).all(today);

    let overdueCount = 0;
    for (const item of newlyOverdue) {
      db.prepare(
        "UPDATE commitments SET status = 'overdue', updated_at = datetime('now') WHERE id = ?"
      ).run(item.id);
      overdueCount++;
    }

    // Count items needing follow-up
    const needingFollowup = getNeedingFollowup(ctx);
    const followupCount = needingFollowup.length;

    ctx.log.info(
      `Commitment check: ${overdueCount} newly overdue, ${followupCount} needing follow-up`
    );
  },
};
