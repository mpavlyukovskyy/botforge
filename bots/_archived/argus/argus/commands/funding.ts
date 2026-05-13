/**
 * /funding — Current funding rates, arb opportunities, collected payments
 */

import { getDb } from '../lib/db.js';
import { SAFETY_LIMITS } from '../lib/config.js';

export default {
  command: 'funding',
  description: 'Show funding rate data and arb status',
  async execute(_args: string, ctx: any) {
    const db = getDb();

    // Latest funding rates
    const rates = db.prepare(`
      SELECT asset, rate, annualized, timestamp
      FROM funding_rates
      WHERE (asset, timestamp) IN (
        SELECT asset, MAX(timestamp) FROM funding_rates GROUP BY asset
      )
      ORDER BY annualized DESC
    `).all() as Array<{ asset: string; rate: number; annualized: number; timestamp: string }>;

    const lines = ['*Funding Rates*', `${'─'.repeat(30)}`];

    if (rates.length === 0) {
      lines.push('No funding rate data yet.');
    } else {
      for (const r of rates) {
        const annPct = (r.annualized * 100).toFixed(2);
        const rate8h = (r.rate * 100).toFixed(4);
        const meetsEntry = r.annualized >= SAFETY_LIMITS.MIN_FUNDING_ANNUALIZED;
        const icon = meetsEntry ? '🟢' : '⚪';
        lines.push(`${icon} *${r.asset}*: ${rate8h}% (8h) = ${annPct}% APR`);
      }
    }

    // Arb status
    const arbStrategy = db.prepare(
      "SELECT status FROM strategies WHERE id = 'funding-rate'"
    ).get() as { status: string } | undefined;

    lines.push('');
    lines.push(`*Arb Status:* ${arbStrategy?.status ?? 'not initialized'}`);

    // Collected funding
    const fundingPositions = db.prepare(`
      SELECT asset, side, size FROM positions
      WHERE strategy = 'funding-rate'
    `).all() as Array<{ asset: string; side: string; size: number }>;

    if (fundingPositions.length > 0) {
      lines.push('');
      lines.push('*Active Arb Positions:*');
      for (const p of fundingPositions) {
        lines.push(`  ${p.side.toUpperCase()} ${p.size} ${p.asset}`);
      }
    }

    // Recent funding payments from trade log
    const payments = db.prepare(`
      SELECT asset, fill_size, confirmed_at FROM trade_wal
      WHERE strategy = 'funding-rate' AND direction = 'buy'
      AND status = 'confirmed'
      ORDER BY confirmed_at DESC LIMIT 5
    `).all() as Array<{ asset: string; fill_size: string; confirmed_at: string }>;

    if (payments.length > 0) {
      lines.push('');
      lines.push('*Recent Funding Collected:*');
      for (const p of payments) {
        lines.push(`  ${p.asset}: $${p.fill_size} at ${p.confirmed_at}`);
      }
    }

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: lines.join('\n'),
    });
  },
};
