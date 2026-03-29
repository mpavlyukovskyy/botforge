/**
 * Cron: yield_rebalance — runs every 4 hours
 *
 * Delegates to YieldStrategy.evaluate() which handles:
 * - sUSDe peg health check (emergency exit if depegged)
 * - Yield differential analysis across protocols
 * - Cost-effective rebalancing when differential > 2%
 * - Circuit breaker checks
 */

import { getDb } from '../lib/db.js';
import type { YieldStrategy } from '../strategies/yield.js';

// Strategy instance is set from lifecycle/start.ts
let strategyInstance: YieldStrategy | null = null;

export function setYieldStrategy(strategy: YieldStrategy): void {
  strategyInstance = strategy;
}

export default {
  name: 'yield_rebalance',
  async execute(ctx: any) {
    const db = getDb();

    // Check if strategy is active
    const strategy = db.prepare(
      "SELECT status FROM strategies WHERE id = 'yield'"
    ).get() as { status: string } | undefined;

    if (!strategy || strategy.status !== 'active') return;

    try {
      if (strategyInstance) {
        await strategyInstance.evaluate();
      } else {
        ctx.log.warn('Yield rebalance: strategy not initialized');
      }
    } catch (err) {
      ctx.log.error(`Yield rebalance error: ${err}`);
    }
  },
};
