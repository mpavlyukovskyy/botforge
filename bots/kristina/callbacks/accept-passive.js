import { findTaskByIdPrefix, createItem, ensureDb, getColumns, findColumnByName } from '../lib/atlas-client.js';
import { getRegisteredChat } from '../lib/db.js';

export default {
  prefix: 'y',
  async execute(data, ctx) {
    const idPrefix = data.split(':')[1];
    if (!idPrefix) { await ctx.answerCallback('Error'); return; }

    const task = findTaskByIdPrefix(ctx, idPrefix);
    if (!task) { await ctx.answerCallback('Not found'); return; }

    const db = ensureDb(ctx.config);
    const registered = getRegisteredChat(ctx, ctx.chatId, ctx.userId);
    const requester = registered?.requester_name || ctx.userName || 'Unknown';

    // Update status from PENDING to OPEN
    db.prepare("UPDATE tasks SET status = 'OPEN', source = 'passive', updated_at = datetime('now') WHERE id = ?").run(task.id);

    // Sync to Atlas
    const columns = await getColumns(ctx);
    const col = findColumnByName(task.column_name || 'To Do', columns);

    const atlasResult = await createItem(ctx, {
      title: task.title,
      columnId: col?.id,
      requester,
      requesterChatId: ctx.chatId,
    });

    if (atlasResult) {
      db.prepare("UPDATE tasks SET spok_id = ?, synced_at = datetime('now') WHERE id = ?")
        .run(atlasResult.atlasId, task.id);
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
