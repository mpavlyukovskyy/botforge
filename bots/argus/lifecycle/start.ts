/**
 * Lifecycle start hook — runs on bot startup
 *
 * 1. Initialize database and strategies
 * 2. Connect execution adapters (Hyperliquid, Arbitrum)
 * 3. Create strategy instances with DI wiring
 * 4. Register strategies with cron jobs
 * 5. Run startup reconciliation
 * 6. Ping healthchecks.io
 */

import { getDb, initializeStrategies } from '../lib/db.js';
import { ALERT_CONFIG, IS_TESTNET, IS_PAPER_TRADING } from '../lib/config.js';
import { HyperliquidAdapter } from '../execution/hyperliquid.js';
import { ArbitrumAdapter } from '../execution/arbitrum.js';
import { FundingRateStrategy } from '../strategies/funding-rate.js';
import { YieldStrategy } from '../strategies/yield.js';
import { createFundingRateDeps, createYieldDeps } from '../strategies/deps.js';
import { setFundingRateStrategy, setHyperliquidAdapter as setFundingHL } from '../cron/funding-rate-check.js';
import { setHyperliquidAdapter as setMarketHL } from '../cron/market-monitor.js';
import { setYieldStrategy } from '../cron/yield-rebalance.js';
import { setArbitrumAdapter as setYieldMonitorArb } from '../cron/yield-monitor.js';
import { setHyperliquidAdapter as setReconHL, setArbitrumAdapter as setReconArb } from '../cron/reconciliation.js';

export default {
  event: 'start',
  async execute(ctx: any) {
    ctx.log.info('Argus starting up...');

    // 1. Initialize database
    const db = getDb();
    initializeStrategies(db);
    ctx.log.info('Database initialized, strategies created');

    // 2. Connect execution adapters
    const sendFn = (params: { chatId: string; text: string }) => ctx.adapter.send(params);

    let hlAdapter: HyperliquidAdapter | null = null;
    let arbAdapter: ArbitrumAdapter | null = null;

    try {
      hlAdapter = new HyperliquidAdapter({ testnet: IS_TESTNET });
      await hlAdapter.connect();
      ctx.log.info(`Hyperliquid adapter connected (testnet=${IS_TESTNET})`);
    } catch (err) {
      ctx.log.error(`Hyperliquid adapter failed to connect: ${err}`);
    }

    try {
      arbAdapter = new ArbitrumAdapter();
      const arbPrivateKey = process.env.ARGUS_WALLET_KEY;
      await arbAdapter.connect(arbPrivateKey);
      ctx.log.info(`Arbitrum adapter connected (testnet=${IS_TESTNET})`);
    } catch (err) {
      ctx.log.error(`Arbitrum adapter failed to connect: ${err}`);
    }

    // 3. Create strategy instances
    if (hlAdapter && arbAdapter) {
      const fundingDeps = createFundingRateDeps(hlAdapter, arbAdapter, sendFn);
      const fundingStrategy = new FundingRateStrategy(fundingDeps);
      setFundingRateStrategy(fundingStrategy);
      setFundingHL(hlAdapter);
      ctx.log.info('Funding rate strategy initialized');

      const yieldDeps = createYieldDeps(arbAdapter, sendFn);
      const yieldStrategy = new YieldStrategy(yieldDeps);
      setYieldStrategy(yieldStrategy);
      ctx.log.info('Yield strategy initialized');
    } else {
      ctx.log.warn('Adapters not fully connected — strategies not initialized');
    }

    // Register adapters for cron jobs
    if (hlAdapter) {
      setMarketHL(hlAdapter);
      setReconHL(hlAdapter);
    }

    if (arbAdapter) {
      setYieldMonitorArb(arbAdapter);
      setReconArb(arbAdapter);
    }

    // 4. Run startup reconciliation
    try {
      const { getIncompleteTradeEntries } = await import('../safety/trade-wal.js');
      const incomplete = getIncompleteTradeEntries();
      if (incomplete.length > 0) {
        ctx.log.warn(`Found ${incomplete.length} incomplete WAL entries — manual review needed`);
        await ctx.adapter.send({
          chatId: ALERT_CONFIG.telegramChatId,
          text: `⚠️ *Startup Warning*\n${incomplete.length} incomplete trade entries found in WAL.\nRun /reconcile to review.`,
        });
      }
    } catch (err) {
      ctx.log.error(`Startup reconciliation failed: ${err}`);
    }

    // 5. Ping healthchecks.io
    if (ALERT_CONFIG.healthchecksPingUrl) {
      try {
        await fetch(ALERT_CONFIG.healthchecksPingUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
        ctx.log.info('Healthchecks.io ping sent');
      } catch (err) {
        ctx.log.warn(`Healthchecks.io ping failed: ${err}`);
      }
    }

    // 6. Send startup notification
    const mode = IS_PAPER_TRADING ? '📝 PAPER' : IS_TESTNET ? '🧪 TESTNET' : '🟢 LIVE';
    try {
      await ctx.adapter.send({
        chatId: ALERT_CONFIG.telegramChatId,
        text: `${mode} *Argus Online*\nAdapters: HL=${hlAdapter ? '✓' : '✗'} ARB=${arbAdapter ? '✓' : '✗'}`,
      });
    } catch (err) {
      ctx.log.warn(`Failed to send startup notification: ${err}`);
    }

    ctx.log.info('Argus startup complete');
  },
};
