/**
 * Callback: fix-action (prefix: 'fix')
 *
 * Handles taps on the fix-menu confirm buttons.
 * callback_data format: 'fix:<planId>:<actionId>'
 *
 * The dashboard does ALL the real work (operator allowlist, atomic
 * single-use consume, period locks, the actual Xero/CC operations) and
 * posts the OUTCOME to the chat as its own message. This handler only:
 *  - forwards the tap (planId/actionId/userId) to /api/telegram-bot/fix-execute
 *  - answers the callback with the immediate ack ("working…", "already
 *    executed", "expired") so the tapper's spinner resolves fast.
 */
import { postDashboard } from '../lib/findlays-api.js';

export default {
  prefix: 'fix',
  async execute(data, ctx) {
    const parts = String(data || '').split(':');
    const planId = parts[1] || '';
    const actionId = parts[2] || '';
    if (!planId || !actionId) {
      await ctx.answerCallback('Bad button data');
      return;
    }
    try {
      const { status, body } = await postDashboard('/api/telegram-bot/fix-execute', {
        planId,
        actionId,
        userId: ctx.userId,
        userName: ctx.userName,
      });
      const toast =
        body && typeof body.text === 'string' && body.text.length > 0
          ? body.text.slice(0, 190) // Telegram answerCallbackQuery text cap (~200)
          : status === 200
            ? 'Working…'
            : 'Failed — try /fix again';
      await ctx.answerCallback(toast);
      ctx.log?.info?.(`[hali99/fix-action] ${data} by ${ctx.userId} -> ${status}`);
    } catch (err) {
      ctx.log?.error?.(`[hali99/fix-action] ${data} failed: ${err?.message || err}`);
      await ctx.answerCallback("Couldn't reach the dashboard — try again");
    }
  },
};
