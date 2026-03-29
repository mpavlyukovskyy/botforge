/**
 * Context builder — injects current portfolio state into LLM context
 */

import { getDb, getPortfolioValue } from '../lib/db.js';

export default {
  type: 'portfolio_state',
  async build(_ctx: any): Promise<string> {
    const db = getDb();

    const strategies = db.prepare(
      'SELECT id, status, allocation_pct, current_value, total_pnl FROM strategies'
    ).all() as Array<{
      id: string; status: string; allocation_pct: number;
      current_value: number; total_pnl: number;
    }>;

    const positions = db.prepare(
      'SELECT strategy, asset, protocol, side, size, current_price, unrealized_pnl FROM positions'
    ).all() as Array<{
      strategy: string; asset: string; protocol: string;
      side: string; size: number; current_price: number | null; unrealized_pnl: number | null;
    }>;

    const totalValue = getPortfolioValue(db);

    const lines = [
      '<current_positions>',
      `Total Portfolio Value: $${totalValue.toFixed(2)}`,
      '',
      'Strategies:',
    ];

    for (const s of strategies) {
      lines.push(`  ${s.id}: ${s.status} | $${s.current_value.toFixed(2)} (${(s.allocation_pct * 100).toFixed(0)}%) | P&L: $${s.total_pnl.toFixed(2)}`);
    }

    if (positions.length > 0) {
      lines.push('');
      lines.push('Open Positions:');
      for (const p of positions) {
        const pnlStr = p.unrealized_pnl != null ? `PnL: $${p.unrealized_pnl.toFixed(2)}` : '';
        lines.push(`  ${p.strategy} | ${p.side} ${p.size} ${p.asset} on ${p.protocol} ${pnlStr}`);
      }
    }

    lines.push('</current_positions>');
    return lines.join('\n');
  },
};
