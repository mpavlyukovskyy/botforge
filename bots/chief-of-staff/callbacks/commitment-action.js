/**
 * Callback: commitment-action (prefix: 'ca')
 *
 * Handles inline keyboard actions for commitment notification cards.
 * callback_data format: 'ca:ACTION:COMMITMENT_ID'
 * Actions: confirm, dismiss, done, extend
 */
import { ensureDb, logAudit } from '../lib/db.js';
import { fulfillCommitment, cancelCommitment, updateCommitment, getCommitment } from '../lib/commitments-db.js';

export default {
  prefix: 'ca',
  async execute(data, ctx) {
    const parts = data.split(':');
    const action = parts[1];
    const commitmentId = parts.slice(2).join(':');

    if (!action || !commitmentId) {
      await ctx.answerCallback('Error: invalid data');
      return;
    }

    const db = ensureDb(ctx.config);
    const commitment = getCommitment(ctx, commitmentId);

    if (!commitment) {
      await ctx.answerCallback('Commitment not found');
      return;
    }

    if (action === 'confirm') {
      // Positive extraction feedback -- boost confidence
      const newConfidence = Math.min(1.0, (commitment.confidence || 0.5) + 0.2);
      updateCommitment(ctx, commitmentId, { confidence: newConfidence });

      db.prepare(`
        INSERT INTO extraction_feedback (id, source_ref, extracted_text, system_classification, mark_classification, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, 'commitment', 'confirmed', datetime('now'))
      `).run(commitment.source_ref || null, commitment.description);

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
            text: `\u2713 Confirmed: ${commitment.description}`,
          });
        } catch {}
      }
      await ctx.answerCallback('Confirmed');
      return;
    }

    if (action === 'dismiss') {
      // False positive -- cancel commitment and log feedback
      cancelCommitment(ctx, commitmentId, 'Dismissed as false positive');

      db.prepare(`
        INSERT INTO extraction_feedback (id, source_ref, extracted_text, system_classification, mark_classification, is_false_positive, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, 'commitment', 'false_positive', 1, datetime('now'))
      `).run(commitment.source_ref || null, commitment.description);

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
            text: `\u2717 Dismissed: ~${commitment.description}~`,
            parseMode: 'Markdown',
          });
        } catch {}
      }
      await ctx.answerCallback('Dismissed');
      return;
    }

    if (action === 'done') {
      fulfillCommitment(ctx, commitmentId, 'Marked done via callback');
      logAudit(ctx, 'commitment_fulfilled', `${commitmentId}: ${commitment.description}`);

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
            text: `\u2705 Done: ${commitment.description}`,
          });
        } catch {}
      }
      await ctx.answerCallback('Done!');
      return;
    }

    if (action === 'extend') {
      // Extend due date by 3 days
      const currentDue = commitment.due_date || new Date().toISOString().slice(0, 10);
      const extended = new Date(currentDue);
      extended.setDate(extended.getDate() + 3);
      const newDueDate = extended.toISOString().slice(0, 10);

      updateCommitment(ctx, commitmentId, { dueDate: newDueDate });
      logAudit(ctx, 'commitment_extended', `${commitmentId}: extended to ${newDueDate}`);

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
            text: `\u23f3 Extended to ${newDueDate}: ${commitment.description}`,
          });
        } catch {}
      }
      await ctx.answerCallback(`Extended to ${newDueDate}`);
      return;
    }

    await ctx.answerCallback('Unknown action');
  },
};
