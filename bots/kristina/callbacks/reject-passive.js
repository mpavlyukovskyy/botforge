import { findTaskByIdPrefix, ensureDb } from '../lib/atlas-client.js';

export default {
  prefix: 'n',
  async execute(data, ctx) {
    const idPrefix = data.split(':')[1];
    if (!idPrefix) { await ctx.answerCallback('Error'); return; }

    const task = findTaskByIdPrefix(ctx, idPrefix);
    if (task) {
      const db = ensureDb(ctx.config);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    }

    // Edit message
    if (ctx.adapter.edit) {
      try {
        await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
          text: '_Dismissed_',
          parseMode: 'Markdown',
        });
      } catch {}
    }

    await ctx.answerCallback('Dismissed');
  },
};
