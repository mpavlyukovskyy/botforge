/**
 * /fixmap <mapId> <ccId> — stage a customer-mapping repair. The dashboard
 * validates LIVE (CC name lookup, husk/duplicate checks) and sends the
 * two-step confirm message itself. Bot relays refusals/usage errors only.
 */
import { postDashboard } from '../lib/findlays-api.js';

export default {
  command: 'fixmap',
  description: 'Repair a flagged customer mapping: /fixmap <mapId> <ccId>',
  async execute(args, ctx) {
    try {
      await ctx.adapter.sendChatAction?.(ctx.chatId, 'typing');
    } catch {
      /* cosmetic only */
    }
    try {
      const { status, body } = await postDashboard('/api/telegram-bot/fixmap', {
        chatId: ctx.chatId,
        userId: ctx.userId,
        userName: ctx.userName,
        args: String(args || '').trim(),
      });
      if (body && typeof body.text === 'string' && body.text.length > 0) {
        await ctx.adapter.send({ chatId: ctx.chatId, text: body.text });
      } else if (status !== 200) {
        await ctx.adapter.send({ chatId: ctx.chatId, text: "Couldn't validate the mapping — try again in a minute." });
      }
      ctx.log?.info?.(`[hali99/fixmap] "${args}" by ${ctx.userId} -> ${status}`);
    } catch (err) {
      ctx.log?.error?.(`[hali99/fixmap] failed: ${err?.message || err}`);
      await ctx.adapter.send({ chatId: ctx.chatId, text: "Couldn't reach the dashboard — try again in a minute." });
    }
  },
};
