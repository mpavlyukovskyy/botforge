import { z } from 'zod';
import { sendDraft } from '../lib/gmail-client.js';
import { ensureDb, logAudit } from '../lib/db.js';
import { updateStatus } from '../lib/priority-queue.js';

const sendDraftTool = {
  name: 'send_draft',
  description:
    'Send a previously created Gmail draft. Updates the gmail_drafts table status ' +
    'to "sent" and logs an audit event. Use the draft_id returned by create_draft.',
  schema: {
    draft_id: z.string().describe('Gmail draft ID (from create_draft result)'),
  },
  permissions: { db: 'write', adapter: 'send' },
  execute: async (args, ctx) => {
    const { draft_id } = args;

    let result;
    try {
      result = await sendDraft(draft_id);
    } catch (err) {
      return `Gmail not configured — cannot send drafts. Error: ${err.message}`;
    }

    if (!result || !result.messageId) {
      return `Failed to send draft ${draft_id}.`;
    }

    // Update gmail_drafts table status
    const db = ensureDb(ctx.config);
    try {
      db.prepare(
        `UPDATE gmail_drafts SET status = 'sent', acted_at = datetime('now') WHERE draft_id = ?`
      ).run(draft_id);
    } catch (err) {
      // Row may not exist if draft was created outside the bot — that's fine
    }

    // Mark priority_queue entry as acted (if linked)
    try {
      const queueEntry = db.prepare(
        'SELECT id FROM priority_queue WHERE draft_id = ?'
      ).get(draft_id);
      if (queueEntry) {
        updateStatus(ctx, queueEntry.id, 'acted');
      }
    } catch {}

    // Log audit event
    logAudit(
      ctx,
      'draft_sent',
      `Draft ${draft_id} sent as message ${result.messageId}${result.threadId ? ` in thread ${result.threadId}` : ''}`
    );

    return (
      `Draft sent successfully.\n` +
      `Message ID: ${result.messageId}\n` +
      `Thread ID: ${result.threadId || 'N/A'}`
    );
  },
};

export default sendDraftTool;
