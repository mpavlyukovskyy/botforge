import { z } from 'zod';
import { ensureDb, syncDeduction, createItem, getColumns, findColumnByName } from '../lib/atlas-client.js';
import { getCurrentBillingMonth, getRegisteredChat } from '../lib/db.js';

/**
 * Record a manual deduction against the requester's monthly balance.
 *
 * Two effects:
 *   1. Insert a row into `deductions` (drives /balance + get_balance)
 *   2. Create a "[PENALTY] <reason>" card on the Done column of Atlas
 *      with bounty = -amount, so the dashboard shows it as a visible
 *      penalty event.
 */
const recordDeduction = {
  name: 'record_deduction',
  description: 'Record a manual deduction. Use when a task was promised but failed, or for explicit penalty events.',
  schema: {
    amount: z.number().describe('Amount to deduct in USD (positive, e.g. 1.0 = $1.00)'),
    reason: z.string().describe('Short reason for the deduction (will appear on the penalty card)'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const amount = typeof args.amount === 'number' && args.amount > 0 ? args.amount : 1.0;
    const reason = String(args.reason || '').slice(0, 200);
    if (!reason) return 'Error: deduction reason is required.';

    const deductionId = crypto.randomUUID();
    const billingMonth = getCurrentBillingMonth();
    const registered = getRegisteredChat(ctx, ctx.chatId, ctx.userId);
    const requester = registered?.requester_name || ctx.userName || 'Unknown';

    db.prepare(
      `INSERT INTO deductions (id, amount, reason, requester, requester_chat_id, billing_month, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(deductionId, amount, reason, requester, String(ctx.chatId), billingMonth);

    // Fire-and-forget Atlas sync — local DB is the source of truth.
    syncDeduction(ctx, {
      id: deductionId,
      amount,
      reason,
      requester,
      requesterChatId: String(ctx.chatId),
      billingMonth,
    }).catch(err => ctx.log.warn(`[record_deduction] Atlas sync failed: ${err}`));

    // Create a visible PENALTY card on the Done column
    try {
      const columns = await getColumns(ctx);
      const doneCol = findColumnByName('Done', columns);
      if (doneCol) {
        const penaltyTaskId = crypto.randomUUID();
        const penaltyTitle = `[PENALTY] ${reason}`;
        db.prepare(
          `INSERT INTO tasks (id, title, status, earned_status, current_value, column_id, column_name, requester, requester_chat_id, source, created_at, updated_at)
           VALUES (?, ?, 'DONE', 'PENALTY', 0, ?, 'Done', ?, ?, 'telegram', datetime('now'), datetime('now'))`
        ).run(penaltyTaskId, penaltyTitle, doneCol.id, requester, String(ctx.chatId));

        createItem(ctx, {
          title: penaltyTitle,
          columnId: doneCol.id,
          status: 'DONE',
          earnedStatus: 'PENALTY',
          bounty: -amount,
          requester,
          requesterChatId: String(ctx.chatId),
        }).then(result => {
          if (result) {
            db.prepare("UPDATE tasks SET spok_id = ?, synced_at = datetime('now') WHERE id = ?")
              .run(result.atlasId, penaltyTaskId);
          }
        }).catch(err => ctx.log.warn(`[record_deduction] penalty-card sync failed: ${err}`));
      }
    } catch (err) {
      ctx.log.warn(`[record_deduction] could not create penalty card: ${err}`);
    }

    return `Deducted $${amount.toFixed(2)} — ${reason}`;
  },
};

export default recordDeduction;
