/**
 * Cron: weekly_report — runs Sunday 01:00 UTC
 *
 * Weekly portfolio summary sent to Telegram.
 * Queries strategies, performance, positions, and trade WAL.
 */

import { getDb, getPortfolioValue } from '../lib/db.js';
import { ALERT_CONFIG } from '../lib/config.js';

export default {
  name: 'weekly_report',
  async execute(ctx: any) {
    const db = getDb();

    try {
      // Strategy values and PnL
      const strategies = db.prepare(
        'SELECT id, status, current_value, total_pnl FROM strategies'
      ).all() as Array<{ id: string; status: string; current_value: number; total_pnl: number }>;

      // 7-day performance trend
      const weeklyPerf = db.prepare(`
        SELECT strategy, SUM(daily_pnl) as week_pnl
        FROM strategy_performance
        WHERE date >= date('now', '-7 days')
        GROUP BY strategy
      `).all() as Array<{ strategy: string; week_pnl: number }>;

      const weekPnlMap = new Map(weeklyPerf.map(p => [p.strategy, p.week_pnl]));

      // Active positions count
      const positionCount = db.prepare(
        'SELECT COUNT(*) as count FROM positions'
      ).get() as { count: number };

      // Trades this week
      const tradeCount = db.prepare(`
        SELECT COUNT(*) as count FROM trade_wal
        WHERE created_at >= datetime('now', '-7 days')
      `).get() as { count: number };

      // Confirmed vs failed trades this week
      const tradeStats = db.prepare(`
        SELECT status, COUNT(*) as count FROM trade_wal
        WHERE created_at >= datetime('now', '-7 days')
        GROUP BY status
      `).all() as Array<{ status: string; count: number }>;

      const confirmed = tradeStats.find(t => t.status === 'confirmed')?.count ?? 0;
      const failed = tradeStats.find(t => t.status === 'failed')?.count ?? 0;

      // Reconciliation health
      const reconCount = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN is_clean = 0 THEN 1 ELSE 0 END) as dirty
        FROM reconciliation_log
        WHERE timestamp >= datetime('now', '-7 days')
      `).get() as { total: number; dirty: number };

      // Build message
      const totalValue = getPortfolioValue(db);
      const totalWeekPnl = [...weekPnlMap.values()].reduce((sum, v) => sum + v, 0);
      const weekSign = totalWeekPnl >= 0 ? '+' : '';

      const lines = [
        '📊 *Weekly Portfolio Report*',
        `${'─'.repeat(28)}`,
        `💰 Portfolio Value: $${totalValue.toFixed(2)}`,
        `📈 Week P&L: ${weekSign}$${totalWeekPnl.toFixed(2)}`,
        '',
        '*Strategies:*',
      ];

      for (const s of strategies) {
        const weekPnl = weekPnlMap.get(s.id) ?? 0;
        const sign = weekPnl >= 0 ? '+' : '';
        const statusIcon = s.status === 'active' ? '🟢' : s.status === 'paused' ? '⏸' : '🔴';
        lines.push(`${statusIcon} ${s.id}: $${s.current_value.toFixed(2)} (${sign}$${weekPnl.toFixed(2)} this week)`);
      }

      lines.push('');
      lines.push('*Activity:*');
      lines.push(`📍 Active positions: ${positionCount.count}`);
      lines.push(`🔄 Trades: ${tradeCount.count} (✓${confirmed} ✗${failed})`);
      lines.push(`🔍 Reconciliations: ${reconCount.total} (${reconCount.dirty} with issues)`);

      await ctx.adapter.send({
        chatId: ALERT_CONFIG.telegramChatId,
        text: lines.join('\n'),
      });
    } catch (err) {
      ctx.log.error(`Weekly report error: ${err}`);
    }
  },
};
