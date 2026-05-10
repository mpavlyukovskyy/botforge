import { confirmLunchOrder, getLunchOrder } from '../lib/db.js';

const DAY_MAP = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

export default {
  prefix: 'lo',
  async execute(data, ctx) {
    // Parse "lo:weekOf:dayAbbrev:rank"
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

    // Check if already confirmed for this day
    const existing = getLunchOrder(ctx.config, weekOf, day);
    if (existing) {
      await ctx.answerCallback(`Already confirmed for ${day}`);
      return;
    }

    // Confirm order (writes to DB)
    const order = confirmLunchOrder(ctx.config, weekOf, day, rank);
    if (!order) {
      await ctx.answerCallback('Recommendation not found');
      return;
    }

    // Toast notification
    await ctx.answerCallback(`Confirmed #${rank} for ${day}!`);

    // Send confirmation message with item details
    // (Do NOT attempt adapter.edit — ctx.messageId is callback query ID, not message_id)
    let confirmText = `✅ *Confirmed for ${day}:*\n`;

    if (order.combo_json) {
      try {
        const combo = JSON.parse(order.combo_json);
        if (Array.isArray(combo) && combo.length > 0) {
          confirmText += `*${order.restaurant || 'Unknown'}*\n`;
          for (const item of combo) {
            const itemPrice = item.price ? ` — $${item.price.toFixed(2)}` : '';
            confirmText += `  • ${item.name}${itemPrice}\n`;
          }
          confirmText += `Total: $${order.price?.toFixed(2) || '?'}`;
          await ctx.adapter.send({ chatId: ctx.chatId, text: confirmText, parseMode: 'Markdown' });
          return;
        }
      } catch { /* fall through to single-item display */ }
    }

    const price = order.price ? ` — $${order.price.toFixed(2)}` : '';
    confirmText += `*${order.item_name}*${price}`;
    if (order.restaurant) confirmText += `\n_${order.restaurant}_`;

    await ctx.adapter.send({ chatId: ctx.chatId, text: confirmText, parseMode: 'Markdown' });
  },
};
