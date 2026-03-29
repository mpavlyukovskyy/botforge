/**
 * Context builder — injects strategy performance metrics into LLM context
 */

import { getDb } from '../lib/db.js';

export default {
  type: 'strategy_metrics',
  async build(_ctx: any): Promise<string> {
    const db = getDb();

    // Recent performance
    const recentPerf = db.prepare(`
      SELECT strategy, date, daily_pnl, total_pnl, sharpe, max_drawdown
      FROM strategy_performance
      WHERE date >= date('now', '-7 days')
      ORDER BY date DESC, strategy
    `).all() as Array<{
      strategy: string; date: string; daily_pnl: number | null;
      total_pnl: number | null; sharpe: number | null; max_drawdown: number | null;
    }>;

    // Latest funding rates
    const fundingRates = db.prepare(`
      SELECT asset, rate, annualized
      FROM funding_rates
      WHERE (asset, timestamp) IN (
        SELECT asset, MAX(timestamp) FROM funding_rates GROUP BY asset
      )
    `).all() as Array<{ asset: string; rate: number; annualized: number }>;

    // Latest yields
    const yields = db.prepare(`
      SELECT protocol, asset, apy
      FROM yields
      WHERE (protocol, asset, timestamp) IN (
        SELECT protocol, asset, MAX(timestamp) FROM yields GROUP BY protocol, asset
      )
    `).all() as Array<{ protocol: string; asset: string; apy: number }>;

    // Recent trades
    const recentTrades = db.prepare(`
      SELECT strategy, asset, direction, size, fill_price, status, created_at
      FROM trade_wal
      WHERE created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT 20
    `).all() as Array<{
      strategy: string; asset: string; direction: string;
      size: string; fill_price: string | null; status: string; created_at: string;
    }>;

    const lines = ['<strategy_metrics>'];

    if (recentPerf.length > 0) {
      lines.push('7-Day Performance:');
      for (const p of recentPerf) {
        const dailyStr = p.daily_pnl != null ? `$${p.daily_pnl.toFixed(2)}` : 'N/A';
        lines.push(`  ${p.date} ${p.strategy}: daily=${dailyStr}, sharpe=${p.sharpe?.toFixed(2) ?? 'N/A'}`);
      }
    }

    if (fundingRates.length > 0) {
      lines.push('');
      lines.push('Current Funding Rates:');
      for (const r of fundingRates) {
        lines.push(`  ${r.asset}: ${(r.rate * 100).toFixed(4)}% (8h) = ${(r.annualized * 100).toFixed(2)}% APR`);
      }
    }

    if (yields.length > 0) {
      lines.push('');
      lines.push('Current Yields:');
      for (const y of yields) {
        lines.push(`  ${y.protocol} ${y.asset}: ${(y.apy * 100).toFixed(2)}% APY`);
      }
    }

    if (recentTrades.length > 0) {
      lines.push('');
      lines.push('Recent Trades:');
      for (const t of recentTrades) {
        lines.push(`  ${t.created_at} ${t.strategy} ${t.direction} ${t.size} ${t.asset} [${t.status}]`);
      }
    }

    lines.push('</strategy_metrics>');
    return lines.join('\n');
  },
};
