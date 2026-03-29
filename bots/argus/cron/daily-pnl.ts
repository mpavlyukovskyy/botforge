/**
 * Cron: daily_pnl — runs at 00:00 UTC
 *
 * Snapshots daily P&L for each strategy.
 * Sends daily summary to Telegram.
 */

import { getDb, getPortfolioValue } from '../lib/db.js';
import { ALERT_CONFIG } from '../lib/config.js';

export default {
  name: 'daily_pnl',
  async execute(ctx: any) {
    const db = getDb();

    try {
      // Snapshot each strategy's performance
      const strategies = db.prepare(
        'SELECT id, current_value, total_pnl FROM strategies'
      ).all() as Array<{ id: string; current_value: number; total_pnl: number }>;

      for (const s of strategies) {
        // Get yesterday's total_pnl to calculate daily
        const yesterday = db.prepare(`
          SELECT total_pnl FROM strategy_performance
          WHERE strategy = ? AND date = date('now', '-1 day')
        `).get(s.id) as { total_pnl: number } | undefined;

        const dailyPnl = yesterday ? s.total_pnl - yesterday.total_pnl : s.total_pnl;

        db.prepare(`
          INSERT INTO strategy_performance (date, strategy, daily_pnl, total_pnl)
          VALUES (date('now'), ?, ?, ?)
        `).run(s.id, dailyPnl, s.total_pnl);
      }

      // Send daily summary
      const totalValue = getPortfolioValue(db);
      const totalPnl = strategies.reduce((sum, s) => sum + s.total_pnl, 0);

      const lines = [
        '*Daily P&L Summary*',
        `${'─'.repeat(25)}`,
        `Portfolio: $${totalValue.toFixed(2)}`,
        '',
      ];

      for (const s of strategies) {
        const yesterday = db.prepare(`
          SELECT total_pnl FROM strategy_performance
          WHERE strategy = ? AND date = date('now', '-1 day')
        `).get(s.id) as { total_pnl: number } | undefined;

        const dailyPnl = yesterday ? s.total_pnl - yesterday.total_pnl : s.total_pnl;
        const sign = dailyPnl >= 0 ? '+' : '';
        lines.push(`${s.id}: ${sign}$${dailyPnl.toFixed(2)} (total: $${s.total_pnl.toFixed(2)})`);
      }

      await ctx.adapter.send({
        chatId: ALERT_CONFIG.telegramChatId,
        text: lines.join('\n'),
      });
    } catch (err) {
      ctx.log.error(`Daily PnL snapshot error: ${err}`);
    }
  },
};
