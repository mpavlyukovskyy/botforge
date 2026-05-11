import { getLunchOrder, updateOrderStatus, logOrderAttempt, computeDateForDay } from '../lib/db.js';

const DAY_MAP = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

export default {
  prefix: 'lc',
  async execute(data, ctx) {
    // Parse "lc:weekOf:dayAbbrev:rank"
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

    // Get order from DB — verify status='pending'
    const order = getLunchOrder(ctx.config, weekOf, day);
    if (!order || order.status !== 'pending') {
      await ctx.answerCallback('No pending order');
      return;
    }

    // Verify rank matches — catches race where user tapped Order #1 then Order #2
    if (order.rank !== rank) {
      await ctx.answerCallback('Selection changed — use the latest confirm button');
      return;
    }

    // Answer callback IMMEDIATELY (before any slow Playwright work)
    await ctx.answerCallback('Placing order...');

    // Update status to 'placing'
    updateOrderStatus(ctx.config, weekOf, day, 'placing');

    // Edit the confirmation prompt to remove buttons and show status
    if (order.prompt_message_id) {
      try {
        await ctx.adapter.edit({
          chatId: ctx.chatId,
          messageId: parseInt(order.prompt_message_id, 10),
          text: `*${day}:* Placing order...`,
          parseMode: 'Markdown',
        });
      } catch { /* edit may fail if message too old */ }
    }

    // Send status message
    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: `Placing order on LunchDrop for ${day}...`,
    });

    // Place order via Playwright
    const startTime = Date.now();
    let result;
    try {
      const { placeOrder, clearSession } = await import('../lib/orderer.js');
      const orderDate = computeDateForDay(weekOf, day);

      result = await placeOrder({
        itemName: order.item_name,
        restaurant: order.restaurant,
        date: orderDate,
        comboJson: order.combo_json,
      }, ctx.log);

      // Handle session_expired — retry once with fresh login
      if (!result.success && result.errorCode === 'session_expired') {
        ctx.log?.warn('Session expired, retrying with fresh login...');
        clearSession();
        result = await placeOrder({
          itemName: order.item_name,
          restaurant: order.restaurant,
          date: orderDate,
          comboJson: order.combo_json,
        }, ctx.log);
      }
    } catch (err) {
      result = { success: false, error: err.message, errorCode: 'unknown' };
    }

    const durationMs = Date.now() - startTime;

    if (result.success) {
      updateOrderStatus(ctx.config, weekOf, day, 'ordered');
      logOrderAttempt(ctx.config, weekOf, day, 1, 'success', null, result.screenshot, durationMs);

      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Order placed for ${day}!`,
      });
    } else {
      updateOrderStatus(ctx.config, weekOf, day, 'failed', result.error);
      logOrderAttempt(ctx.config, weekOf, day, 1, 'failed', result.error, result.screenshot, durationMs);

      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Order failed: ${result.error}`,
        inlineKeyboard: [[
          { text: 'Retry', callbackData: `lc:${weekOf}:${dayAbbrev}:${rank}` },
        ]],
      });
    }
  },
};
