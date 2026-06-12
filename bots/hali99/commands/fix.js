/**
 * /fix — billing fix menu. The bot is a dumb trigger: the dashboard builds
 * the open-issues menu AND sends it to this chat itself (with inline confirm
 * buttons, same delivery path as order-alert ack buttons). The bot only
 * speaks when something went wrong or access was refused.
 */
import { postDashboard } from '../lib/findlays-api.js';

export default {
  command: 'fix',
  description: 'Billing fix menu — open issues with confirm buttons',
  async execute(args, ctx) {
    try {
      await ctx.adapter.sendChatAction?.(ctx.chatId, 'typing');
    } catch {
      /* cosmetic only */
    }
    try {
      const { status, body } = await postDashboard('/api/telegram-bot/fix', {
        chatId: ctx.chatId,
        userId: ctx.userId,
        userName: ctx.userName,
      });
      // The menu arrives as the dashboard's own message; only relay
      // refusals/errors (non-empty text).
      if (body && typeof body.text === 'string' && body.text.length > 0) {
        await ctx.adapter.send({ chatId: ctx.chatId, text: body.text });
      } else if (status !== 200) {
        await ctx.adapter.send({ chatId: ctx.chatId, text: "Couldn't build the fix menu — try again in a minute." });
      }
      ctx.log?.info?.(`[hali99/fix] menu requested by ${ctx.userId} -> ${status}`);
    } catch (err) {
      ctx.log?.error?.(`[hali99/fix] failed: ${err?.message || err}`);
      await ctx.adapter.send({ chatId: ctx.chatId, text: "Couldn't reach the dashboard — try again in a minute." });
    }
  },
};
