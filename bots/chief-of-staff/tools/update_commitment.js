import { z } from 'zod';
import {
  updateCommitment,
  fulfillCommitment,
  cancelCommitment,
  recordFollowup,
  getCommitment,
} from '../lib/commitments-db.js';

const updateCommitmentTool = {
  name: 'update_commitment',
  description:
    'Update, fulfill, cancel, or record a follow-up on an existing commitment. ' +
    'Use action "update" to change fields (status, due_date), "fulfill" to mark done, ' +
    '"cancel" to drop it, or "followup" to log a follow-up and bump the next follow-up date.',
  schema: {
    id: z.string().describe('Commitment ID'),
    action: z
      .enum(['update', 'fulfill', 'cancel', 'followup'])
      .describe('Action to perform on the commitment'),
    status: z
      .string()
      .optional()
      .describe('New status (only for action "update")'),
    due_date: z
      .string()
      .optional()
      .describe('New due date in YYYY-MM-DD format (only for action "update")'),
    note: z
      .string()
      .optional()
      .describe('Note or reason (used for fulfill and cancel actions)'),
  },
  permissions: { db: 'write' },
  execute: async (args, ctx) => {
    const { id, action, status, due_date, note } = args;

    // Verify the commitment exists first
    const existing = getCommitment(ctx, id);
    if (!existing) {
      return `Commitment ${id} not found.`;
    }

    switch (action) {
      case 'update': {
        const updates = {};
        if (status) updates.status = status;
        if (due_date) updates.dueDate = due_date;
        const result = updateCommitment(ctx, id, updates);
        const changed = [status && `status=${status}`, due_date && `due=${due_date}`]
          .filter(Boolean)
          .join(', ');
        return `Updated commitment "${result.description}": ${changed || 'no changes'}.`;
      }

      case 'fulfill': {
        const result = fulfillCommitment(ctx, id, note);
        return `Fulfilled commitment "${result.description}"${note ? `: ${note}` : ''}.`;
      }

      case 'cancel': {
        const result = cancelCommitment(ctx, id, note);
        return `Cancelled commitment "${result.description}"${note ? `: ${note}` : ''}.`;
      }

      case 'followup': {
        const result = recordFollowup(ctx, id);
        if (!result) {
          return `Failed to record follow-up for commitment ${id}.`;
        }
        return (
          `Recorded follow-up #${result.followup_count} for "${result.description}". ` +
          `Next follow-up: ${result.next_followup_date}.`
        );
      }

      default:
        return `Unknown action "${action}". Use: update, fulfill, cancel, or followup.`;
    }
  },
};

export default updateCommitmentTool;
