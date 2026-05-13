/**
 * Argus Trading System — Strategy Dependency Factories
 *
 * Maps the concrete execution adapters (HyperliquidAdapter, ArbitrumAdapter)
 * to the strategy dep interfaces. This is the DI wiring layer.
 *
 * Each factory creates a deps object that a strategy constructor accepts.
 */

import type { FundingRateStrategyDeps } from './funding-rate.js';
import type { HyperliquidAdapter } from '../execution/hyperliquid.js';
import type { ArbitrumAdapter } from '../execution/arbitrum.js';
import { ALERT_CONFIG } from '../lib/config.js';
import { getDb } from '../lib/db.js';

// ─── Alert Helper ─────────────────────────────────────────────────────────────

type SendFn = (params: { chatId: string; text: string }) => Promise<void>;

function createAlertSender(sendFn: SendFn) {
  return async (severity: 'warning' | 'critical' | 'emergency', title: string, message: string) => {
    const icon = severity === 'emergency' ? '🔴' : severity === 'critical' ? '🟠' : '🟡';
    const text = `${icon} *${title}*\n${message}`;

    try {
      await sendFn({ chatId: ALERT_CONFIG.telegramChatId, text });
    } catch {
      console.error(`[alert] Failed to send ${severity}: ${title}`);
    }

    // Log to DB
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO alert_log (severity, title, message, channels)
        VALUES (?, ?, ?, 'telegram')
      `).run(severity, title, message);
    } catch { /* non-critical */ }
  };
}

// ─── Funding Rate Strategy Deps ───────────────────────────────────────────────

/**
 * Create FundingRateStrategyDeps from concrete adapters.
 *
 * @param hl - Connected HyperliquidAdapter
 * @param arb - Connected ArbitrumAdapter
 * @param sendFn - Telegram adapter send function (ctx.adapter.send)
 */
export function createFundingRateDeps(
  hl: HyperliquidAdapter,
  arb: ArbitrumAdapter,
  sendFn: SendFn,
): FundingRateStrategyDeps {
  return {
    buySpot: async (asset: string, amount: number) => {
      // Buy WETH on Arbitrum via Uniswap: USDC → WETH
      const result = await arb.swap({
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        amountIn: String(amount * (await hl.getAllMidPrices())[asset]),
        maxSlippagePct: 0.003,
      });
      return {
        success: result.success,
        txHash: result.txHash,
        fillPrice: result.effectivePrice,
        error: result.error,
      };
    },

    sellSpot: async (asset: string, amount: number) => {
      // Sell WETH on Arbitrum via Uniswap: WETH → USDC
      const result = await arb.swap({
        tokenIn: 'WETH',
        tokenOut: 'USDC',
        amountIn: String(amount),
        maxSlippagePct: 0.003,
      });
      return {
        success: result.success,
        txHash: result.txHash,
        fillPrice: result.effectivePrice,
        error: result.error,
      };
    },

    openShort: async (asset: string, size: number, leverage: number) => {
      const result = await hl.placeOrder({
        asset,
        side: 'sell',
        size,
      });
      return {
        success: result.success,
        orderId: result.orderId,
        fillPrice: result.fillPrice,
        error: result.error,
      };
    },

    closeShort: async (asset: string) => {
      // Get current position size to close
      const positions = await hl.getPositions();
      const pos = positions.find(p => p.asset === asset && p.size < 0);
      if (!pos) {
        return { success: false, error: `No short position found for ${asset}` };
      }
      const result = await hl.placeOrder({
        asset,
        side: 'buy',
        size: Math.abs(pos.size),
        reduceOnly: true,
      });
      return {
        success: result.success,
        orderId: result.orderId,
        fillPrice: result.fillPrice,
        error: result.error,
      };
    },

    getFundingRate: async (asset: string) => {
      const info = await hl.getFundingRate(asset);
      return { rate: info.rate, annualized: info.annualized };
    },

    getSpotPrice: async (asset: string) => {
      const mids = await hl.getAllMidPrices();
      return mids[asset] ?? 0;
    },

    getPerpPrice: async (asset: string) => {
      const mids = await hl.getAllMidPrices();
      return mids[asset] ?? 0;
    },

    getMarginRatio: async () => {
      const balances = await hl.getBalances();
      if (balances.total <= 0) return 1;
      return (balances.total - balances.margin) / balances.total;
    },

    getCurrentLeverage: async () => {
      const balances = await hl.getBalances();
      if (balances.free <= 0) return 0;
      return balances.margin > 0 ? balances.total / (balances.total - balances.margin) : 1;
    },

    getOpenInterest: async (asset: string) => {
      return hl.getOpenInterest(asset);
    },

    getFundingHistory: async (asset: string, limit: number) => {
      return hl.getFundingHistory(asset, limit);
    },

    adjustPerp: async (asset: string, sizeDelta: number) => {
      // sizeDelta > 0 = increase short (sell more), < 0 = reduce short (buy back)
      const result = await hl.placeOrder({
        asset,
        side: sizeDelta > 0 ? 'sell' : 'buy',
        size: Math.abs(sizeDelta),
        reduceOnly: sizeDelta < 0,
      });
      return { success: result.success, error: result.error };
    },

    sendAlert: createAlertSender(sendFn),
  };
}

// ─── Yield Strategy Deps ──────────────────────────────────────────────────────

/**
 * Create YieldStrategyDeps from concrete adapters.
 */
export function createYieldDeps(
  arb: ArbitrumAdapter,
  sendFn: SendFn,
) {
  return {
    getAavePositions: () => arb.getAavePositions(),
    getAaveHealthFactor: () => arb.getAaveHealthFactor(),
    aaveSupply: (asset: string, amount: string) => arb.aaveSupply(asset, amount),
    aaveWithdraw: (asset: string, amount: string) => arb.aaveWithdraw(asset, amount),
    getSUSDePriceOnDex: () => arb.getSUSDePriceOnDex(),
    sellSUSDeOnDex: (amount: string, maxSlippage: number) => arb.sellSUSDeOnDex(amount, maxSlippage),
    getBalance: (token: string) => arb.getBalance(token),
    swap: (params: { tokenIn: string; tokenOut: string; amountIn: string; maxSlippagePct: number }) => arb.swap(params),
    sendAlert: createAlertSender(sendFn),
  };
}
