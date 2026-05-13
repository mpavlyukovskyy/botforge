/**
 * Argus Trading System — Weekly Performance Reporter
 *
 * Generates a comprehensive weekly report using Claude:
 * - Portfolio-level P&L, drawdown, Sharpe
 * - Per-strategy breakdown (funding rate, yield, reserve, equities)
 * - Trade activity summary
 * - Risk metrics (health factors, margin ratios)
 * - Notable events (circuit breakers, alerts)
 *
 * Runs as a weekly cron (e.g. Sunday evening) and sends report
 * to Telegram. Also available on-demand via /report command.
 */

import type { StrategyPerformance, TradeWalEntry } from '../lib/types.js';
import { queryClaude } from '../lib/brain.js';
import { getDb } from '../lib/db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MonitorContext {
  /** Send alert to configured channels */
  sendAlert: (severity: 'info' | 'warning' | 'critical', title: string, message: string) => Promise<void>;
}

interface CronHandler {
  name: string;
  execute: (ctx: MonitorContext) => Promise<void>;
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const REPORTER_SYSTEM_PROMPT = `You are a portfolio performance analyst for an automated trading system called Argus.

Your role is to write a clear, concise weekly performance report for the portfolio owner (Mark).

The report should include:
1. Portfolio Summary — total value, weekly P&L, overall return
2. Strategy Breakdown — performance of each strategy (funding rate arb, yield, reserve, ondo equities)
3. Trade Activity — number of trades, largest trades, any failed trades
4. Risk Metrics — drawdown, circuit breaker events, health factors
5. Notable Events — anything unusual or requiring attention
6. Outlook — brief comment on next week's expected activity

Format the report for Telegram (plain text, use line breaks for readability).
Keep it under 2000 characters.
Use numbers and percentages — be precise, not vague.
If data is limited or unavailable, say so clearly.`;

// ─── Report Generation ─────────────────────────────────────────────────────

/**
 * Generate the weekly performance report.
 *
 * Reads data from the database and formats it as context for Claude,
 * then calls the LLM to produce a human-readable summary.
 *
 * @returns Formatted report string ready for Telegram
 *
 * TODO: Enhance with more data sources as strategies go live
 */
export async function generateWeeklyReport(): Promise<string> {
  const db = getDb();

  // 1. Portfolio value
  const portfolioRow = db.prepare(`
    SELECT COALESCE(SUM(current_value), 0) as total_value,
           COALESCE(SUM(total_pnl), 0) as total_pnl
    FROM strategies
  `).get() as { total_value: number; total_pnl: number };

  // 2. Per-strategy performance (last 7 days)
  const strategyPerf = db.prepare(`
    SELECT strategy,
           COALESCE(SUM(daily_pnl), 0) as weekly_pnl,
           MAX(total_pnl) as total_pnl,
           MIN(max_drawdown) as worst_drawdown,
           AVG(sharpe) as avg_sharpe
    FROM strategy_performance
    WHERE date >= date('now', '-7 days')
    GROUP BY strategy
  `).all() as Array<{
    strategy: string;
    weekly_pnl: number;
    total_pnl: number | null;
    worst_drawdown: number | null;
    avg_sharpe: number | null;
  }>;

  // 3. Strategy statuses
  const strategyStatuses = db.prepare(`
    SELECT id, status, allocation_pct, current_value, total_pnl
    FROM strategies
  `).all() as Array<{
    id: string;
    status: string;
    allocation_pct: number;
    current_value: number;
    total_pnl: number;
  }>;

  // 4. Trade activity (last 7 days)
  const trades = db.prepare(`
    SELECT * FROM trade_wal
    WHERE created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC
  `).all() as TradeWalEntry[];

  const tradeStats = {
    total: trades.length,
    confirmed: trades.filter((t) => t.status === 'confirmed').length,
    failed: trades.filter((t) => t.status === 'failed').length,
    pending: trades.filter((t) => t.status === 'pending' || t.status === 'submitted').length,
  };

  // 5. Circuit breaker events (last 7 days)
  const cbEvents = db.prepare(`
    SELECT level, strategy, trigger_name, value, threshold, action, timestamp
    FROM circuit_breaker_events
    WHERE timestamp >= datetime('now', '-7 days')
    ORDER BY timestamp DESC
  `).all() as Array<{
    level: string;
    strategy: string;
    trigger_name: string;
    value: number;
    threshold: number;
    action: string;
    timestamp: string;
  }>;

  // 6. Reconciliation health (last 7 days)
  const reconResults = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN is_clean = 1 THEN 1 ELSE 0 END) as clean,
           SUM(CASE WHEN is_clean = 0 THEN 1 ELSE 0 END) as dirty
    FROM reconciliation_log
    WHERE timestamp >= datetime('now', '-7 days')
  `).get() as { total: number; clean: number; dirty: number };

  // 7. Active positions
  const positions = db.prepare(`
    SELECT strategy, protocol, asset, side, size, entry_price, current_price, unrealized_pnl
    FROM positions
    ORDER BY strategy, protocol
  `).all() as Array<{
    strategy: string;
    protocol: string;
    asset: string;
    side: string;
    size: number;
    entry_price: number;
    current_price: number | null;
    unrealized_pnl: number | null;
  }>;

  // Build context for Claude
  const dataContext = `## Portfolio Summary
Total Value: $${portfolioRow.total_value.toFixed(2)}
Total P&L: $${portfolioRow.total_pnl.toFixed(2)}

## Strategy Statuses
${strategyStatuses.map((s) => `- ${s.id}: ${s.status} (alloc=${(s.allocation_pct * 100).toFixed(0)}%, value=$${s.current_value.toFixed(2)}, pnl=$${s.total_pnl.toFixed(2)})`).join('\n')}

## Weekly Performance by Strategy
${strategyPerf.length > 0
  ? strategyPerf.map((s) =>
      `- ${s.strategy}: weekly=$${s.weekly_pnl.toFixed(2)}, total=$${s.total_pnl?.toFixed(2) ?? 'N/A'}, drawdown=${s.worst_drawdown?.toFixed(4) ?? 'N/A'}, sharpe=${s.avg_sharpe?.toFixed(2) ?? 'N/A'}`,
    ).join('\n')
  : 'No performance data for this week.'}

## Trade Activity (Last 7 Days)
Total: ${tradeStats.total} | Confirmed: ${tradeStats.confirmed} | Failed: ${tradeStats.failed} | Pending: ${tradeStats.pending}
${trades.length > 0
  ? 'Recent trades:\n' + trades.slice(0, 5).map((t) =>
      `  ${t.createdAt} — ${t.direction} ${t.size} ${t.asset} on ${t.protocol} [${t.status}]`,
    ).join('\n')
  : 'No trades this week.'}

## Active Positions
${positions.length > 0
  ? positions.map((p) =>
      `- [${p.strategy}] ${p.side} ${p.size} ${p.asset} on ${p.protocol} @ $${p.entry_price} (now: $${p.current_price ?? 'unknown'}, pnl: $${p.unrealized_pnl ?? 'unknown'})`,
    ).join('\n')
  : 'No active positions.'}

## Circuit Breaker Events
${cbEvents.length > 0
  ? cbEvents.map((e) => `- [${e.level}] ${e.strategy}: ${e.trigger_name} (${e.value} vs threshold ${e.threshold}) → ${e.action}`).join('\n')
  : 'No circuit breaker events this week.'}

## Reconciliation
Total checks: ${reconResults.total} | Clean: ${reconResults.clean} | Discrepancies: ${reconResults.dirty}`;

  // Call Claude
  console.error('[reporter] Generating weekly report via Claude...');

  const response = await queryClaude(
    `Generate a weekly performance report based on the following data:\n\n${dataContext}`,
    {
      systemPrompt: REPORTER_SYSTEM_PROMPT,
      model: 'claude-opus-4-6',
      timeoutMs: 60_000,
    },
  );

  if (response.is_error) {
    throw new Error(`Weekly report generation failed: ${response.result}`);
  }

  console.error(`[reporter] Report generated (${response.result.length} chars, ${response.duration_ms}ms)`);

  return response.result;
}

// ─── Cron Handler ─────────────────────────────────────────────────────────────

/**
 * Weekly report cron handler.
 *
 * Generates the report and sends it to Telegram.
 * Scheduled for Sunday evening (configured externally).
 */
export const weeklyReportCron: CronHandler = {
  name: 'weekly_report',

  async execute(ctx: MonitorContext): Promise<void> {
    try {
      const report = await generateWeeklyReport();
      await ctx.sendAlert('info', 'Weekly Performance Report', report);
      console.error('[reporter] Weekly report sent successfully');
    } catch (err) {
      const msg = `Weekly report failed: ${err instanceof Error ? err.message : err}`;
      console.error(`[reporter] ${msg}`);
      await ctx.sendAlert('warning', 'Weekly Report Failed', msg);
    }
  },
};
