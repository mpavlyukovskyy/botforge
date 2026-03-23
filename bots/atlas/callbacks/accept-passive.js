import { findTaskByIdPrefix, createItem, ensureDb, getColumns, findColumnByName } from '../lib/spok-client.js';

export default {
  prefix: 'y',
  async execute(data, ctx) {
    const idPrefix = data.split(':')[1];
    if (!idPrefix) { await ctx.answerCallback('Error'); return; }

    const task = findTaskByIdPrefix(ctx, idPrefix);
    if (!task) { await ctx.answerCallback('Not found'); return; }

    const db = ensureDb(ctx.config);

    // Update status from PENDING to OPEN
    db.prepare("UPDATE tasks SET status = 'OPEN', source = 'passive', updated_at = datetime('now') WHERE id = ?").run(task.id);

    // Sync to Spok
    const columns = await getColumns(ctx);
    const col = findColumnByName(task.column_name || 'To Do', columns);

    const spokResult = await createItem(ctx, {
      title: task.title,
      columnId: col?.id,
    });

    if (spokResult) {
      db.prepare("UPDATE tasks SET spok_id = ?, synced_at = datetime('now') WHERE id = ?")
        .run(spokResult.atlasId, task.id);
    }

    // Edit message with Undo/Edit/Column buttons
    const buttons = [
      [
        { text: 'Undo', callbackData: `u:${idPrefix}` },
        { text: 'Edit', callbackData: `e:${idPrefix}` },
        { text: 'Column', callbackData: `c:${idPrefix}` },
      ],
    ];

    if (ctx.adapter.edit) {
      try {
        await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
          text: `Created: "${task.title}"`,
          inlineKeyboard: buttons,
        });
      } catch {}
    }

    await ctx.answerCallback('Created');
  },
};
