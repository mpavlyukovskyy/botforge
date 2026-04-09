/**
 * Callback: draft-approval (prefix: 'da')
 *
 * Handles inline keyboard actions for Gmail draft review cards.
 * callback_data format: 'da:ACTION:DRAFT_ID'
 * Actions: send, edit, tomorrow, skip
 */
import { sendDraft } from '../lib/gmail-client.js';
import { ensureDb, logAudit } from '../lib/db.js';
import { updateStatus } from '../lib/priority-queue.js';

function markQueueActed(db, ctx, draftId) {
  try {
    const entry = db.prepare('SELECT id FROM priority_queue WHERE draft_id = ?').get(draftId);
    if (entry) updateStatus(ctx, entry.id, 'acted');
  } catch {}
}

export default {
  prefix: 'da',
  async execute(data, ctx) {
    const parts = data.split(':');
    const action = parts[1];
    const draftId = parts.slice(2).join(':'); // draft IDs may contain colons

    if (!action || !draftId) {
      await ctx.answerCallback('Error: invalid data');
      return;
    }

    const db = ensureDb(ctx.config);

    if (action === 'send') {
      try {
        const result = await sendDraft(draftId);
        db.prepare(
          "UPDATE gmail_drafts SET status = 'sent', acted_at = datetime('now') WHERE draft_id = ?"
        ).run(draftId);
        logAudit(ctx, 'draft_sent', `Draft ${draftId} sent as message ${result.messageId}`);
        markQueueActed(db, ctx, draftId);

        if (ctx.adapter.edit) {
          try {
            await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
              text: '\u2713 Sent',
            });
          } catch {}
        }
        await ctx.answerCallback('Sent!');
      } catch (err) {
        ctx.log.error(`Failed to send draft ${draftId}: ${err.message}`);
        await ctx.answerCallback('Send failed');
      }
      return;
    }

    if (action === 'edit') {
      db.prepare(
        "UPDATE gmail_drafts SET status = 'editing', acted_at = datetime('now') WHERE draft_id = ?"
      ).run(draftId);

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
            text: '\u270f\ufe0f Open Gmail to edit',
          });
        } catch {}
      }
      await ctx.answerCallback('Opened for editing');
      return;
    }

    if (action === 'tomorrow') {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      const expiresAt = tomorrow.toISOString();

      db.prepare(
        "UPDATE gmail_drafts SET expires_at = ?, acted_at = datetime('now') WHERE draft_id = ?"
      ).run(expiresAt, draftId);

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
            text: '\u23f0 Reminded tomorrow',
          });
        } catch {}
      }
      await ctx.answerCallback('Reminded tomorrow');
      return;
    }

    if (action === 'skip') {
      db.prepare(
        "UPDATE gmail_drafts SET status = 'skipped', acted_at = datetime('now') WHERE draft_id = ?"
      ).run(draftId);
      markQueueActed(db, ctx, draftId);

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
            text: '\u2717 Skipped',
          });
        } catch {}
      }
      await ctx.answerCallback('Skipped');
      return;
    }

    await ctx.answerCallback('Unknown action');
  },
};
