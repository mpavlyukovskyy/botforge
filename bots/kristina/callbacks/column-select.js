import { findTaskByIdPrefix, updateItem, getColumns, ensureDb } from '../lib/atlas-client.js';

export default {
  prefix: 'cs',
  async execute(data, ctx) {
    const parts = data.split(':');
    const taskPrefix = parts[1];
    const colPrefix = parts[2];
    if (!taskPrefix || !colPrefix) { await ctx.answerCallback('Error'); return; }

    const task = findTaskByIdPrefix(ctx, taskPrefix);
    if (!task) { await ctx.answerCallback('Not found'); return; }

    // Find full column ID
    const columns = await getColumns(ctx);
    const col = columns.find(c => c.id.startsWith(colPrefix));
    if (!col) { await ctx.answerCallback('Column not found'); return; }

    // Update locally
    const db = ensureDb(ctx.config);
    db.prepare("UPDATE tasks SET column_id = ?, column_name = ?, updated_at = datetime('now') WHERE id = ?")
      .run(col.id, col.name, task.id);

    // Update on Atlas
    if (task.spok_id) await updateItem(ctx, task.spok_id, { columnId: col.id });

    // Edit message
    if (ctx.adapter.edit) {
      try {
        await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
          text: `"${task.title}" → ${col.name}`,
        });
      } catch {}
    }

    await ctx.answerCallback('Moved');
  },
};
