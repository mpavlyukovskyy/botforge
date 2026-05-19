import { z } from 'zod';
import { ensureDb, updateItem } from '../lib/atlas-client.js';
import { findTaskByIdPrefix } from '../lib/db.js';

/**
 * Cancel a task — sets status=ARCHIVED, earned_status=CANCELLED, current_value=0.
 *
 * Removes from the board WITHOUT affecting earnings (use delete_task to
 * remove entirely, or mark_done to credit it). Admin-only by convention.
 */
const cancelTask = {
  name: 'cancel_task',
  description: 'Cancel one or more tasks. Removes from board without affecting earnings. Mark only.',
  schema: {
    item_ids: z.array(z.string()).describe('Array of task IDs (or 8-char prefixes) to cancel'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const ids = args.item_ids || [];
    const results = [];

    for (const idPrefix of ids) {
      const task = findTaskByIdPrefix(ctx, idPrefix);
      if (!task) {
        results.push(`ID "${idPrefix}": not found`);
        continue;
      }

      db.prepare(
        `UPDATE tasks
           SET status = 'ARCHIVED',
               earned_status = 'CANCELLED',
               current_value = 0,
               updated_at = datetime('now')
         WHERE id = ?`
      ).run(task.id);

      if (task.spok_id) {
        await updateItem(ctx, task.spok_id, {
          status: 'ARCHIVED',
          earnedStatus: 'CANCELLED',
        });
      }

      results.push(`Cancelled: "${task.title}" — removed from board, won't affect earnings.`);
    }

    return results.join('\n');
  },
};

export default cancelTask;
