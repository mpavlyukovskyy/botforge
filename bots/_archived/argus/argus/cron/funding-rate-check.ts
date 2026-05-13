/**
 * Cron: funding_rate_check — runs every 5 minutes
 *
 * Delegates to FundingRateStrategy.evaluate() which handles:
 * - Entry signal generation (scan assets, check thresholds, enter best)
 * - Exit condition checking (low rate, negative funding, basis divergence)
 * - Rebalancing and funding collection for active positions
 * - Circuit breaker checks
 *
 * Also polls fresh funding rate data from Hyperliquid and stores in DB.
 */

import { getDb } from '../lib/db.js';
import { STRATEGY_CONFIG, ALERT_CONFIG } from '../lib/config.js';
import type { FundingRateStrategy } from '../strategies/funding-rate.js';
import type { HyperliquidAdapter } from '../execution/hyperliquid.js';

// Strategy instance is set from lifecycle/start.ts
let strategyInstance: FundingRateStrategy | null = null;
let hlAdapter: HyperliquidAdapter | null = null;

export function setFundingRateStrategy(strategy: FundingRateStrategy): void {
  strategyInstance = strategy;
}

export function setHyperliquidAdapter(adapter: HyperliquidAdapter): void {
  hlAdapter = adapter;
}

export default {
  name: 'funding_rate_check',
  async execute(ctx: any) {
    const db = getDb();

    try {
      // 1. Poll fresh funding rates from Hyperliquid and store in DB
      if (hlAdapter?.isConnected()) {
        for (const asset of STRATEGY_CONFIG['funding-rate'].assets) {
          try {
            const { rate, annualized } = await hlAdapter.getFundingRate(asset);
            db.prepare(`
              INSERT INTO funding_rates (timestamp, asset, exchange, rate, annualized)
              VALUES (datetime('now'), ?, 'hyperliquid', ?, ?)
            `).run(asset, rate, annualized);
          } catch (err) {
            ctx.log.warn(`Failed to fetch funding rate for ${asset}: ${err}`);
          }
        }
      }

      // 2. Run strategy evaluation
      if (strategyInstance) {
        await strategyInstance.evaluate();
      }
    } catch (err) {
      ctx.log.error(`Funding rate check error: ${err}`);

      // Alert on repeated failures
      try {
        await ctx.adapter.send({
          chatId: ALERT_CONFIG.telegramChatId,
          text: `🟠 *Funding Rate Check Error*\n${err instanceof Error ? err.message : String(err)}`,
        });
      } catch { /* non-critical */ }
    }
  },
};
