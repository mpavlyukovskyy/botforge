import { z } from 'zod';
import { getColumns, findColumnByName, updateItem, findTaskByIdPrefix, ensureDb } from '../lib/spok-client.js';

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

      // Update local DB
      db.prepare("UPDATE tasks SET status = 'DONE', updated_at = datetime('now') WHERE id = ?").run(task.id);
      if (doneCol) {
        db.prepare("UPDATE tasks SET column_id = ?, column_name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(doneCol.id, doneCol.name, task.id);
      }

      // Update on Spok
      if (task.spok_id) {
        const spokUpdates = { status: 'DONE' };
        if (doneCol) spokUpdates.columnId = doneCol.id;
        await updateItem(ctx, task.spok_id, spokUpdates);
      }

      results.push(`"${task.title}": marked done`);
    }

    return results.join('\n');
  },
};

export default markDone;
