/**
 * Cron: kill_switch_test — runs every Sunday at 03:00 UTC
 *
 * Automated dry-run of the kill switch to verify it still works.
 */

import { executeKillSwitch } from '../safety/kill-switch.js';
import { ALERT_CONFIG } from '../lib/config.js';

export default {
  name: 'kill_switch_test',
  async execute(ctx: any) {
    ctx.log.info('Running weekly kill switch dry-run test');

    try {
      const result = await executeKillSwitch(
        {
          cancelAllOrders: async () => ({ cancelled: 0, errors: [] }),
          closeAllPerps: async () => ({ closed: 0, errors: [] }),
          withdrawAllAave: async () => ({ withdrawn: 0, errors: [] }),
          sendAlert: async () => {},
        },
        { dryRun: true },
      );

      if (result.errors.length === 0) {
        ctx.log.info('Kill switch dry-run passed');
        await ctx.adapter.send({
          chatId: ALERT_CONFIG.telegramChatId,
          text: `✅ Weekly kill switch test passed (${result.executionTimeMs}ms)`,
        });
      } else {
        ctx.log.error(`Kill switch dry-run had errors: ${result.errors.join(', ')}`);
        await ctx.adapter.send({
          chatId: ALERT_CONFIG.telegramChatId,
          text: `⚠️ Weekly kill switch test had errors:\n${result.errors.join('\n')}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.error(`Kill switch test failed: ${msg}`);
      await ctx.adapter.send({
        chatId: ALERT_CONFIG.telegramChatId,
        text: `🔴 Weekly kill switch test FAILED: ${msg}`,
      });
    }
  },
};
