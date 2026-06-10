/**
 * Cron handler: nudge_deductions
 *
 * 7:05pm ET Sun-Thu. For each nudge sent today that wasn't responded to
 * (task still In Progress, not DONE, no recent message), apply a $0.10
 * deduction. Hard cap of $5/day per chat to prevent runaway penalties.
 *
 * Ported from standalone src/nudge/scheduler.ts:applyDeductions. The
 * per-chat cap is intentional — Sara/Hendrik shouldn't get hit with
 * unlimited deductions on a day they're sick or away.
 */
import { DateTime } from 'luxon';
import { ensureDb, syncDeduction } from '../lib/atlas-client.js';
import { isWorkingDay, TIMEZONE } from '../lib/working-hours.js';
import { getCurrentBillingMonth } from '../lib/db.js';
import { loadAtlasPresence, shouldSkipRun } from '../lib/presence.js';
import { reconcile } from '../lib/sync.js';

const DAILY_DEDUCTION_CAP = 5; // 50 nudges = $5.00 max per chat
const DEDUCTION_CENTS = 10;

export default {
  name: 'nudge_deductions',
  async execute(ctx) {
    const now = DateTime.now().setZone(TIMEZONE);
    if (!isWorkingDay(now)) {
      ctx.log.debug('nudge_deductions: not a work day');
      return;
    }
    const today = now.toFormat('yyyy-MM-dd');

    const db = ensureDb(ctx.config);

    // Phase 0: money cron — reconcile to Atlas truth FIRST so we never charge
    // against a stale cache. Only an explicit abort skips; skipped/disabled
    // falls through to the presence backstop below. RT-D3.
    const rep = await reconcile(ctx);
    if (rep?.aborted) {
      ctx.log.warn(`nudge_deductions: reconcile aborted (${rep.aborted}), skipping run`);
      return;
    }

    // Bleed-stopper backstop: never charge money for a task Atlas no longer has,
    // and never charge when Atlas can't be verified. See lib/presence.js.
    const presence = await loadAtlasPresence(ctx);
    if (shouldSkipRun(presence)) {
      ctx.log.warn('nudge_deductions: Atlas unverifiable, skipping run');
      return;
    }

    // Pre-aggregate per-chat deduction counts already applied today
    const chatCounts = db.prepare(
      `SELECT t.requester_chat_id AS chatId, COUNT(*) AS cnt
         FROM nudge_log nl
         JOIN tasks t ON nl.task_id = t.id
        WHERE nl.nudge_date = ? AND nl.deduction_applied = 1
          AND t.requester_chat_id IS NOT NULL
        GROUP BY t.requester_chat_id`
    ).all(today);
    const chatDeductions = new Map(chatCounts.map(r => [r.chatId, r.cnt]));
    const capNotified = new Set();
    const chatCharges = new Map(); // chatId -> [{id,title,amount}] for one summary DM

    const pending = db.prepare(
      `SELECT nl.id, nl.task_id, nl.nudge_date
         FROM nudge_log nl
        WHERE nl.nudge_date = ?
          AND nl.responded_at IS NULL
          AND nl.deduction_applied = 0
          AND nl.delivered = 1`
    ).all(today);

    let applied = 0;
    for (const row of pending) {
      const task = db.prepare(
        `SELECT id, spok_id, title, status, column_name, requester_chat_id
           FROM tasks WHERE id = ?`
      ).get(row.task_id);

      // Ghost (deleted in Atlas) → close the nudge, never charge.
      if (task && presence.skip(task)) {
        db.prepare("UPDATE nudge_log SET responded_at = ? WHERE id = ?")
          .run(new Date().toISOString(), row.id);
        continue;
      }

      // Task moved out of In Progress / completed → close the nudge
      if (!task || task.status === 'DONE' || task.status === 'ARCHIVED' || task.column_name !== 'In Progress') {
        db.prepare("UPDATE nudge_log SET responded_at = ? WHERE id = ?")
          .run(new Date().toISOString(), row.id);
        continue;
      }
      if (!task.requester_chat_id) continue;

      const chatId = task.requester_chat_id;
      const count = chatDeductions.get(chatId) || 0;
      if (count >= DAILY_DEDUCTION_CAP) {
        if (!capNotified.has(chatId)) {
          try {
            await ctx.adapter.send({
              chatId,
              text: 'Daily deduction cap reached. No further deductions today.',
            });
          } catch { /* ignore */ }
          capNotified.add(chatId);
        }
        continue;
      }

      const deductionId = crypto.randomUUID();
      const billingMonth = getCurrentBillingMonth();
      const reason = `No update on '${task.title}'`;
      const amount = DEDUCTION_CENTS / 100;

      const synced = await syncDeduction(ctx, { id: deductionId, amount, reason, billingMonth });
      if (!synced) {
        ctx.log.warn(`nudge_deductions: Atlas sync failed for ${task.id} — leaving deduction_applied=0 for retry`);
        continue;
      }

      db.prepare(
        `INSERT INTO deductions (id, amount, reason, requester, requester_chat_id, billing_month, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(deductionId, amount, reason, 'System', chatId, billingMonth);
      db.prepare(
        "UPDATE nudge_log SET deduction_applied = 1, deduction_amount_cents = ? WHERE id = ?"
      ).run(DEDUCTION_CENTS, row.id);
      chatDeductions.set(chatId, (chatDeductions.get(chatId) || 0) + 1);

      // Accumulate for ONE summary DM per chat (no 50-DM spam), each line
      // carrying a (D:id) contest handle. Procedural justice: every charge is
      // transparent + contestable.
      if (!chatCharges.has(chatId)) chatCharges.set(chatId, []);
      chatCharges.get(chatId).push({ id: deductionId, title: task.title, amount });
      applied++;
    }

    // One summary DM per chat with contest handles.
    for (const [chatId, charges] of chatCharges.entries()) {
      const total = charges.reduce((s, c) => s + c.amount, 0).toFixed(2);
      const lines = charges.map(c => `• $${c.amount.toFixed(2)} — ${c.title} (D:${c.id.slice(0, 8)})`).join('\n');
      try {
        await ctx.adapter.send({
          chatId,
          text: `Logged $${total} in deductions today for no update on:\n${lines}\n\nIf any was unfair, reply "contest D:<id>" and I'll flag it for Mark.`,
        });
      } catch (err) {
        ctx.log.warn(`nudge_deductions: summary DM failed for ${chatId}: ${err}`);
      }
    }

    if (applied > 0) ctx.log.info(`nudge_deductions: applied ${applied} deductions for ${today}`);
  },
};
