import { findTaskByIdPrefix, updateItem, getColumns, findColumnByName, ensureDb } from '../lib/atlas-client.js';
import { markTaskDoneLocally } from '../lib/db.js';

export default {
  prefix: 'd',
  async execute(data, ctx) {
    const idPrefix = data.split(':')[1];
    if (!idPrefix) { await ctx.answerCallback('Error'); return; }

    const task = findTaskByIdPrefix(ctx, idPrefix);
    if (!task) { await ctx.answerCallback('Not found'); return; }

    const db = ensureDb(ctx.config);

    // Move to Done column
    const columns = await getColumns(ctx);
    const doneCol = findColumnByName('Done', columns);

    // Earn the (decay/handoff-aware) value + set status=DONE/earned_status=EARNED
    // locally (the single done path; previously this earned $0).
    const { earnedValue } = markTaskDoneLocally(ctx, task.id);
    if (doneCol) {
      db.prepare("UPDATE tasks SET column_id = ?, column_name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(doneCol.id, doneCol.name, task.id);
    }

    // Update on Atlas (status + frozen earned state)
    if (task.spok_id) {
      const updates = { status: 'DONE', earnedStatus: 'EARNED', earnedValue };
      if (doneCol) updates.columnId = doneCol.id;
      await updateItem(ctx, task.spok_id, updates);
    }

    // Edit message
    if (ctx.adapter.edit) {
      try {
        await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
          text: `✓ "${task.title}" — done`,
        });
      } catch {}
    }

    await ctx.answerCallback('Done!');
  },
};
