import { z } from 'zod';
import { deleteItem, findTaskByIdPrefix, ensureDb } from '../lib/atlas-client.js';

const deleteTask = {
  name: 'delete_task',
  description: 'Delete a task from the board entirely.',
  schema: {
    item_id: z.string().describe('Task ID to delete'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const task = findTaskByIdPrefix(ctx, args.item_id);
    if (!task) return `No task found matching ID "${args.item_id}".`;

    // Delete from Atlas
    if (task.spok_id) {
      await deleteItem(ctx, task.spok_id);
    }

    // Delete locally
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    return `Deleted: "${task.title}"`;
  },
};

export default deleteTask;
