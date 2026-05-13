/**
 * Kill switch confirmation callback — double-tap pattern
 *
 * Handles:
 * - kill:confirm → execute kill switch
 * - kill:cancel → abort
 */

import { confirmKill, cancelKillConfirmation, executeKillSwitch, formatKillSwitchReport } from '../safety/kill-switch.js';

export default {
  prefix: 'kill',
  description: 'Kill switch confirmation/cancellation',
  async execute(data: string, ctx: any) {
    const action = data.split(':')[1];

    if (action === 'cancel') {
      cancelKillConfirmation(ctx.chatId);
      await ctx.answerCallback();
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: '❌ Kill switch cancelled.',
      });
      return;
    }

    if (action === 'confirm') {
      const confirmed = confirmKill(ctx.chatId);

      if (!confirmed) {
        await ctx.answerCallback();
        await ctx.adapter.send({
          chatId: ctx.chatId,
          text: '⚠️ Confirmation expired or invalid. Use /kill again.',
        });
        return;
      }

      await ctx.answerCallback();
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: '🔴 EXECUTING KILL SWITCH...',
      });

      try {
        // TODO: Wire real execution adapters
        const result = await executeKillSwitch({
          cancelAllOrders: async () => ({ cancelled: 0, errors: [] }),
          closeAllPerps: async () => ({ closed: 0, errors: [] }),
          withdrawAllAave: async () => ({ withdrawn: 0, errors: [] }),
          sendAlert: async (severity, title, message) => {
            // Alert is the Telegram message itself
            ctx.log?.info(`[${severity}] ${title}: ${message}`);
          },
        });

        const report = formatKillSwitchReport(result, false);
        await ctx.adapter.send({
          chatId: ctx.chatId,
          text: report,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.adapter.send({
          chatId: ctx.chatId,
          text: `Kill switch error: ${msg}\n\nCheck positions manually!`,
        });
      }
    }
  },
};
