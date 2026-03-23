import { getColumns, findTaskByIdPrefix } from '../lib/spok-client.js';

export default {
  prefix: 'c',
  async execute(data, ctx) {
    const idPrefix = data.split(':')[1];
    if (!idPrefix) { await ctx.answerCallback('Error'); return; }

    const task = findTaskByIdPrefix(ctx, idPrefix);
    if (!task) { await ctx.answerCallback('Not found'); return; }

    const columns = await getColumns(ctx);
    const buttons = columns.map(col => ([{
      text: col.name,
      callbackData: `cs:${idPrefix}:${col.id.slice(0, 8)}`,
    }]));

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: `Move "${task.title}" to:`,
      inlineKeyboard: buttons,
    });

    await ctx.answerCallback();
  },
};
