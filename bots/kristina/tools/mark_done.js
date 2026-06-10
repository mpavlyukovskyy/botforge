import { z } from 'zod';
import { getColumns, findColumnByName, updateItem, findTaskByIdPrefix, ensureDb } from '../lib/atlas-client.js';
import { markTaskDoneLocally } from '../lib/db.js';

const markDone = {
  name: 'mark_done',
  description: 'Mark one or more tasks as done. Provide an array of item IDs.',
  schema: {
    item_ids: z.array(z.string()).describe('Array of task IDs to mark done'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const ids = args.item_ids || [];
    const results = [];

    // Pre-fetch columns for Done column resolution
    const columns = await getColumns(ctx);
    const doneCol = findColumnByName('Done', columns);

    for (const idPrefix of ids) {
      const task = findTaskByIdPrefix(ctx, idPrefix);
      if (!task) {
        results.push(`ID "${idPrefix}": not found`);
        continue;
      }

      // Compute the earned (decay/handoff-aware) value and set status=DONE,
      // earned_status=EARNED, current_value locally. Previously mark_done only
      // set status=DONE, so bot-completed tasks earned $0 in the balance — the
      // earning logic in markTaskDoneLocally was dead. Now it's the one path.
      const { earnedValue, financialNote } = markTaskDoneLocally(ctx, task.id);
      if (doneCol) {
        db.prepare("UPDATE tasks SET column_id = ?, column_name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(doneCol.id, doneCol.name, task.id);
      }

      // Push the frozen done-state to Atlas (the single financial authority):
      // status, earnedStatus, earnedValue — so the dashboard and reconcile agree.
      if (task.spok_id) {
        const atlasUpdates = { status: 'DONE', earnedStatus: 'EARNED', earnedValue };
        if (doneCol) atlasUpdates.columnId = doneCol.id;
        await updateItem(ctx, task.spok_id, atlasUpdates);
      }

      results.push(`"${task.title}": marked done (${financialNote})`);
    }

    return results.join('\n');
  },
};

export default markDone;
