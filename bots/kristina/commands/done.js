import { getItems } from '../lib/atlas-client.js';
import { getRegisteredChat } from '../lib/db.js';

export default {
  command: 'done',
  description: 'Show tasks to mark as done',
  async execute(args, ctx) {
    const registered = getRegisteredChat(ctx, ctx.chatId, ctx.userId);
    const requester = registered?.requester_name;
    const items = await getItems(ctx, { status: 'OPEN' });
    const filtered = items.filter(i => !i.requester || (requester && (i.requester === requester || i.assignee === requester)));

    if (filtered.length === 0) {
      await ctx.adapter.send({ chatId: ctx.chatId, text: 'No open items to mark done.' });
      return;
    }

    const buttons = filtered.slice(0, 10).map(item => ([{
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
