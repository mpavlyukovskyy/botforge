import { findTaskByIdPrefix, deleteItem, ensureDb } from '../lib/spok-client.js';

export default {
  prefix: 'u',
  async execute(data, ctx) {
    const idPrefix = data.split(':')[1];
    if (!idPrefix) { await ctx.answerCallback('Error'); return; }

    const task = findTaskByIdPrefix(ctx, idPrefix);
    if (!task) { await ctx.answerCallback('Not found'); return; }

    // Delete from Spok
    if (task.spok_id) await deleteItem(ctx, task.spok_id);

    // Delete locally
    const db = ensureDb(ctx.config);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);

    // Edit message with strikethrough
    if (ctx.adapter.edit) {
      try {
        await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
          text: `~${task.title}~ — removed`,
          parseMode: 'Markdown',
        });
      } catch {}
    }

    await ctx.answerCallback('Removed');
  },
};
