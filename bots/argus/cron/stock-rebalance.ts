/**
 * Cron: stock_rebalance — runs quarterly (1st of every 3rd month at 09:00 UTC)
 *
 * LLM-driven Ondo equity rebalance.
 * ondo-equities.enabled = false by default, so this safely no-ops.
 * When enabled: runs analysis, sends plan to Telegram for manual approval.
 * No auto-execution.
 */

import { STRATEGY_CONFIG, ALERT_CONFIG } from '../lib/config.js';
import { runStockAnalysis, formatPlanForTelegram } from '../intelligence/stock-strategist.js';

export default {
  name: 'stock_rebalance',
  async execute(ctx: any) {
    const config = STRATEGY_CONFIG['ondo-equities'];
    if (!config.enabled) return;

    try {
      ctx.log.info('Running quarterly stock rebalance analysis...');

      const plan = await runStockAnalysis();
      const message = formatPlanForTelegram(plan);

      await ctx.adapter.send({
        chatId: ALERT_CONFIG.telegramChatId,
        text: `📈 *Quarterly Stock Rebalance Plan*\n\n${message}\n\n_Reply /approve\\_rebalance to execute or ignore to skip._`,
      });

      ctx.log.info('Stock rebalance plan sent to Telegram for approval');
    } catch (err) {
      ctx.log.error(`Stock rebalance error: ${err}`);

      try {
        await ctx.adapter.send({
          chatId: ALERT_CONFIG.telegramChatId,
          text: `🟠 *Stock Rebalance Error*\n${err instanceof Error ? err.message : String(err)}`,
        });
      } catch { /* non-critical */ }
    }
  },
};
