/**
 * /positions — Detailed position breakdown per strategy
 */

import { getDb } from '../lib/db.js';
import type { Position } from '../lib/types.js';

export default {
  command: 'positions',
  description: 'Show detailed position breakdown',
  async execute(_args: string, ctx: any) {
    const db = getDb();

    const positions = db.prepare(`
      SELECT * FROM positions ORDER BY strategy, protocol, asset
    `).all() as Position[];

    if (positions.length === 0) {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: 'No open positions.',
      });
      return;
    }

    const grouped = new Map<string, Position[]>();
    for (const p of positions) {
      const key = p.strategy;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(p);
    }

    const lines = ['*Open Positions*', `${'─'.repeat(30)}`];

    for (const [strategy, stratPositions] of grouped) {
      lines.push('');
      lines.push(`*${strategy}*`);

      for (const p of stratPositions) {
        const pnlStr = p.unrealizedPnl != null
          ? (p.unrealizedPnl >= 0 ? `+$${p.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(p.unrealizedPnl).toFixed(2)}`)
          : 'N/A';
        const priceStr = p.currentPrice != null ? `$${p.currentPrice.toFixed(2)}` : 'N/A';

        lines.push(
          `  ${p.side.toUpperCase()} ${p.size} ${p.asset} on ${p.protocol}`,
          `    Entry: $${p.entryPrice.toFixed(2)} | Current: ${priceStr} | PnL: ${pnlStr}`,
        );
      }
    }

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: lines.join('\n'),
    });
  },
};
