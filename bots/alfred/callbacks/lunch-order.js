import { getLunchOrder, setPendingOrder, getRecommendation, computeDateForDay } from '../lib/db.js';

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

    // Validate date is not in the past
    const orderDate = computeDateForDay(weekOf, day);
    if (orderDate) {
      const today = new Date().toISOString().slice(0, 10);
      if (orderDate < today) {
        await ctx.answerCallback(`Can't order for past date (${day})`);
        return;
      }
    }

    // Check existing order for this day
    const existing = getLunchOrder(ctx.config, weekOf, day);
    if (existing) {
      if (existing.status === 'ordered') {
        await ctx.answerCallback(`Already ordered for ${day}`);
        return;
      }
      if (existing.status === 'placing') {
        await ctx.answerCallback(`Order in progress for ${day}`);
        return;
      }
      // pending or failed — allow re-selection (will overwrite via INSERT OR REPLACE)
    }

    // Look up recommendation
    const rec = getRecommendation(ctx.config, weekOf, day, rank);
    if (!rec) {
      await ctx.answerCallback('Recommendation not found');
      return;
    }

    // Dismiss the button spinner immediately
    await ctx.answerCallback();

    // Build confirmation message
    let confirmText = `*Confirm order for ${day}?*\n\n`;
    if (rec.combo_json) {
      try {
        const combo = JSON.parse(rec.combo_json);
        if (Array.isArray(combo) && combo.length > 0) {
          confirmText += `*${rec.restaurant || 'Unknown'}*\n`;
          for (const item of combo) {
            const itemPrice = item.price ? ` — $${item.price.toFixed(2)}` : '';
            confirmText += `  • ${item.name}${itemPrice}\n`;
          }
          confirmText += `Total: $${rec.price?.toFixed(2) || '?'}`;
        }
      } catch { /* fall through */ }
    }

    if (!confirmText.includes('•')) {
      const price = rec.price ? ` — $${rec.price.toFixed(2)}` : '';
      confirmText += `*${rec.item_name}*${price}`;
      if (rec.restaurant) confirmText += `\n_${rec.restaurant}_`;
    }

    // Send confirmation prompt with Confirm/Cancel buttons
    const sent = await ctx.adapter.send({
      chatId: ctx.chatId,
      text: confirmText,
      parseMode: 'Markdown',
      inlineKeyboard: [[
        { text: 'Confirm', callbackData: `lc:${weekOf}:${dayAbbrev}:${rank}` },
        { text: 'Cancel', callbackData: `lx:${weekOf}:${dayAbbrev}:${rank}` },
      ]],
    });

    // Store prompt message ID so we can edit it later
    const promptMessageId = sent?.message_id || sent?.messageId || null;

    // Create pending order in DB
    setPendingOrder(ctx.config, weekOf, day, rank, promptMessageId ? String(promptMessageId) : null);
  },
};
