/**
 * /status — Show all strategies, total P&L, allocation percentages
 */

import { getDb } from '../lib/db.js';
import type { Strategy } from '../lib/types.js';

export default {
  command: 'status',
  description: 'Show portfolio status and strategy overview',
  async execute(_args: string, ctx: any) {
    const db = getDb();

    const strategies = db.prepare(
      'SELECT * FROM strategies ORDER BY allocation_pct DESC'
    ).all() as Strategy[];

    const totalValue = strategies.reduce((sum, s) => sum + s.currentValue, 0);
    const totalPnl = strategies.reduce((sum, s) => sum + s.totalPnl, 0);

    const lines = [
      '*Argus Portfolio Status*',
      `${'─'.repeat(30)}`,
      `Total Value: $${totalValue.toFixed(2)}`,
      `Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
      '',
      '*Strategies:*',
    ];

    for (const s of strategies) {
      const statusIcon = s.status === 'active' ? '🟢'
        : s.status === 'paused' ? '🟡'
        : s.status === 'halted' ? '🔴'
        : '⚪';
      const pnlStr = s.totalPnl >= 0 ? `+$${s.totalPnl.toFixed(2)}` : `-$${Math.abs(s.totalPnl).toFixed(2)}`;
      lines.push(
        `${statusIcon} *${s.id}* (${(s.allocationPct * 100).toFixed(0)}%)`,
        `   Value: $${s.currentValue.toFixed(2)} | P&L: ${pnlStr}`,
      );
    }

    // Trade activity
    const recentTrades = db.prepare(`
      SELECT COUNT(*) as count FROM trade_wal
      WHERE created_at > datetime('now', '-24 hours')
      AND status = 'confirmed'
    `).get() as { count: number };

    lines.push('');
    lines.push(`Trades (24h): ${recentTrades.count}`);

    // Last reconciliation
    const lastRecon = db.prepare(`
      SELECT timestamp, is_clean FROM reconciliation_log
      ORDER BY timestamp DESC LIMIT 1
    `).get() as { timestamp: string; is_clean: number } | undefined;

    if (lastRecon) {
      const reconStatus = lastRecon.is_clean ? 'Clean' : 'DISCREPANCIES';
      lines.push(`Last Reconciliation: ${reconStatus} (${lastRecon.timestamp})`);
    }

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: lines.join('\n'),
    });
  },
};
