import { findTaskByIdPrefix, updateItem, getColumns, findColumnByName, ensureDb } from '../lib/atlas-client.js';

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

    db.prepare("UPDATE tasks SET status = 'DONE', updated_at = datetime('now') WHERE id = ?").run(task.id);
    if (doneCol) {
      db.prepare("UPDATE tasks SET column_id = ?, column_name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(doneCol.id, doneCol.name, task.id);
    }

    // Update on Atlas
    if (task.spok_id) {
      const updates = { status: 'DONE' };
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
