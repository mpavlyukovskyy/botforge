import { getItems } from '../lib/spok-client.js';

export default {
  command: 'done',
  description: 'Show tasks to mark as done',
  async execute(args, ctx) {
    const items = await getItems(ctx, { status: 'OPEN' });

    if (items.length === 0) {
      await ctx.adapter.send({ chatId: ctx.chatId, text: 'No open items to mark done.' });
      return;
    }

    const buttons = items.slice(0, 10).map(item => ([{
      text: item.title.slice(0, 40),
      callbackData: `d:${item.id.slice(0, 8)}`,
    }]));

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: 'Tap to mark done:',
      inlineKeyboard: buttons,
    });
  },
};
