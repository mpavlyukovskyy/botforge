/**
 * /yields — Current protocol APYs, active positions, health factors
 */

import { getDb } from '../lib/db.js';

export default {
  command: 'yields',
  description: 'Show yield data and positions',
  async execute(_args: string, ctx: any) {
    const db = getDb();

    // Latest yields per protocol
    const yields = db.prepare(`
      SELECT protocol, asset, apy, tvl, timestamp
      FROM yields
      WHERE (protocol, asset, timestamp) IN (
        SELECT protocol, asset, MAX(timestamp)
        FROM yields GROUP BY protocol, asset
      )
      ORDER BY apy DESC
    `).all() as Array<{ protocol: string; asset: string; apy: number; tvl: number | null; timestamp: string }>;

    const lines = ['*Protocol Yields*', `${'─'.repeat(30)}`];

    if (yields.length === 0) {
      lines.push('No yield data yet.');
    } else {
      for (const y of yields) {
        const apyPct = (y.apy * 100).toFixed(2);
        const tvlStr = y.tvl != null ? ` (TVL: $${(y.tvl / 1e6).toFixed(1)}M)` : '';
        lines.push(`  *${y.protocol}* ${y.asset}: ${apyPct}% APY${tvlStr}`);
      }
    }

    // Yield positions
    const yieldPositions = db.prepare(`
      SELECT asset, protocol, side, size, current_price, unrealized_pnl
      FROM positions WHERE strategy = 'yield'
      ORDER BY protocol
    `).all() as Array<{
      asset: string; protocol: string; side: string; size: number;
      current_price: number | null; unrealized_pnl: number | null;
    }>;

    if (yieldPositions.length > 0) {
      lines.push('');
      lines.push('*Active Yield Positions:*');
      for (const p of yieldPositions) {
        const valueStr = p.current_price != null ? `$${(p.size * p.current_price).toFixed(2)}` : `${p.size}`;
        lines.push(`  ${p.protocol}: ${valueStr} ${p.asset} (${p.side})`);
      }
    }

    // Strategy status
    const yieldStrategy = db.prepare(
      "SELECT status, current_value, total_pnl FROM strategies WHERE id = 'yield'"
    ).get() as { status: string; current_value: number; total_pnl: number } | undefined;

    if (yieldStrategy) {
      lines.push('');
      lines.push(`*Strategy:* ${yieldStrategy.status}`);
      lines.push(`*Value:* $${yieldStrategy.current_value.toFixed(2)}`);
      lines.push(`*P&L:* ${yieldStrategy.total_pnl >= 0 ? '+' : ''}$${yieldStrategy.total_pnl.toFixed(2)}`);
    }

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: lines.join('\n'),
    });
  },
};
