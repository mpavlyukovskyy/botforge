/**
 * LLM Tool: get_status — returns portfolio status for brain context
 */

import { z } from 'zod';
import { getDb, getPortfolioValue } from '../lib/db.js';

export default {
  name: 'get_status',
  description: 'Get current portfolio status including all strategies, total P&L, and allocation',
  schema: {},
  async execute(_args: unknown, _ctx: any): Promise<string> {
    const db = getDb();

    const strategies = db.prepare(
      'SELECT id, status, allocation_pct, current_value, total_pnl FROM strategies ORDER BY allocation_pct DESC'
    ).all() as Array<{
      id: string; status: string; allocation_pct: number;
      current_value: number; total_pnl: number;
    }>;

    const totalValue = getPortfolioValue(db);
    const totalPnl = strategies.reduce((sum, s) => sum + s.total_pnl, 0);

    const recentTrades = db.prepare(`
      SELECT COUNT(*) as count FROM trade_wal
      WHERE created_at > datetime('now', '-24 hours') AND status = 'confirmed'
    `).get() as { count: number };

    return JSON.stringify({
      totalValue,
      totalPnl,
      trades24h: recentTrades.count,
      strategies: strategies.map((s) => ({
        id: s.id,
        status: s.status,
        allocationPct: s.allocation_pct,
        currentValue: s.current_value,
        totalPnl: s.total_pnl,
      })),
    });
  },
};
