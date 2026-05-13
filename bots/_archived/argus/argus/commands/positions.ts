/**
 * /positions — Detailed position breakdown per strategy
 */

import { getDb } from '../lib/db.js';

/** Row shape returned by SQLite (snake_case columns) */
interface PositionRow {
  id: number;
  strategy: string;
  asset: string;
  protocol: string;
  side: string;
  size: number;
  entry_price: number;
  current_price: number | null;
  unrealized_pnl: number | null;
  opened_at: string;
  updated_at: string;
}

export default {
  command: 'positions',
  description: 'Show detailed position breakdown',
  async execute(_args: string, ctx: any) {
    const db = getDb();

    const positions = db.prepare(`
      SELECT * FROM positions ORDER BY strategy, protocol, asset
    `).all() as PositionRow[];

    if (positions.length === 0) {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: 'No open positions.',
      });
      return;
    }

    const grouped = new Map<string, PositionRow[]>();
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
        const pnlStr = p.unrealized_pnl != null
          ? (p.unrealized_pnl >= 0 ? `+$${p.unrealized_pnl.toFixed(2)}` : `-$${Math.abs(p.unrealized_pnl).toFixed(2)}`)
          : 'N/A';
        const priceStr = p.current_price != null ? `$${p.current_price.toFixed(2)}` : 'N/A';

        lines.push(
          `  ${p.side.toUpperCase()} ${p.size} ${p.asset} on ${p.protocol}`,
          `    Entry: $${p.entry_price.toFixed(2)} | Current: ${priceStr} | PnL: ${pnlStr}`,
        );
      }
    }

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: lines.join('\n'),
    });
  },
};
