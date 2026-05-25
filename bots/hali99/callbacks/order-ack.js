/**
 * Callback: order-ack (prefix: 'ack')
 *
 * Handles the "✅ Acknowledged" inline-button tap on new-order alerts
 * posted to the Findlays ops Telegram group.
 *
 * callback_data format: 'ack:<orderId>'
 *
 * Effect:
 *  - answerCallback (toast "Acknowledged" appears on the tapper's client)
 *  - edits the original message to append "✅ Acknowledged by @user at HH:MM"
 *  - removes the inline keyboard so it can't be re-tapped
 *
 * Context fields used (botforge CallbackContext):
 *   ctx.chatId     — string of chat id (e.g. "-5181340999")
 *   ctx.messageId  — string of the message_id hosting the inline keyboard
 *                    (requires botforge-core fix: messageId comes from
 *                    callback.raw.message.message_id, NOT callback.id)
 *   ctx.userName   — first_name OR username (string)
 *   ctx.adapter.edit(messageId, chatId, { text, inlineKeyboard? })
 *   ctx.answerCallback(text) — shows toast to tapper
 */
export default {
  prefix: 'ack',
  async execute(data, ctx) {
    const orderId = data.slice(4); // 'ack:'.length === 4
    if (!orderId) {
      await ctx.answerCallback('Missing order id');
      return;
    }

    const who = ctx.userName ? `@${ctx.userName.replace(/^@/, '')}` : 'staff';

    // NZ local time HH:MM
    const nowNZ = new Date().toLocaleString('en-NZ', {
      timeZone: 'Pacific/Auckland',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    // Edit in place — we don't have the original text here, so append a
    // simple status line by replacing the message body with a minimal ack
    // marker plus reference to the order id. Plain text (no parseMode).
    if (ctx.adapter?.edit) {
      try {
        await ctx.adapter.edit(ctx.messageId, ctx.chatId, {
          text: `✅ Order ${orderId} — acknowledged by ${who} at ${nowNZ}`,
          inlineKeyboard: [],
        });
      } catch (e) {
        ctx.log?.error?.(`[hali99/order-ack] edit failed for ${orderId}: ${e?.message || e}`);
      }
    }

    await ctx.answerCallback('Acknowledged');
    ctx.log?.info?.(`[hali99/order-ack] order ${orderId} acked by ${who}`);
  },
};
