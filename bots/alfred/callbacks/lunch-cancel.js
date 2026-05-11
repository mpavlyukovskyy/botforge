import { getLunchOrder, deleteLunchOrder } from '../lib/db.js';

const DAY_MAP = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

export default {
  prefix: 'lx',
  async execute(data, ctx) {
    // Parse "lx:weekOf:dayAbbrev:rank"
    const parts = data.split(':');
    if (parts.length !== 4) {
      await ctx.answerCallback('Invalid');
      return;
    }

    const [, weekOf, dayAbbrev, rankStr] = parts;
    const day = DAY_MAP[dayAbbrev];
    const rank = parseInt(rankStr, 10);

    if (!day || isNaN(rank) || rank < 1) {
      await ctx.answerCallback('Invalid');
      return;
    }

    // Get order — verify status='pending'
    const order = getLunchOrder(ctx.config, weekOf, day);
    if (!order || order.status !== 'pending') {
      await ctx.answerCallback('No pending order to cancel');
      return;
    }

    // Delete the order row
    deleteLunchOrder(ctx.config, weekOf, day);

    // Edit confirmation prompt message to show cancelled, remove buttons
    if (order.prompt_message_id) {
      try {
        await ctx.adapter.edit({
          chatId: ctx.chatId,
          messageId: parseInt(order.prompt_message_id, 10),
          text: `*${day}:* Cancelled`,
          parseMode: 'Markdown',
        });
      } catch { /* edit may fail if message too old */ }
    }

    await ctx.answerCallback('Cancelled');
  },
};
