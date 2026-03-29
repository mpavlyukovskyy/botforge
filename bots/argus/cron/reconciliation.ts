/**
 * Cron: reconciliation — runs every 30 minutes
 *
 * Compares DB state against exchange/chain state.
 * Alerts on discrepancies. NEVER auto-corrects.
 */

import { runReconciliation } from '../safety/reconciliation.js';
import { ALERT_CONFIG } from '../lib/config.js';
import type { HyperliquidAdapter } from '../execution/hyperliquid.js';
import type { ArbitrumAdapter } from '../execution/arbitrum.js';

// Adapters set from lifecycle/start.ts
let hlAdapter: HyperliquidAdapter | null = null;
let arbAdapter: ArbitrumAdapter | null = null;

export function setHyperliquidAdapter(adapter: HyperliquidAdapter): void {
  hlAdapter = adapter;
}

export function setArbitrumAdapter(adapter: ArbitrumAdapter): void {
  arbAdapter = adapter;
}

const RECONCILE_TOKENS = ['WETH', 'USDC', 'sUSDe', 'USDe', 'USDY'];

export default {
  name: 'reconciliation',
  async execute(ctx: any) {
    try {
      const result = await runReconciliation({
        getHyperliquidPositions: async () => {
          if (!hlAdapter?.isConnected()) return [];
          const positions = await hlAdapter.getPositions();
          return positions.map(p => ({
            asset: p.asset,
            size: p.size,
            entryPrice: p.entryPrice,
          }));
        },
        getHyperliquidOpenOrders: async () => {
          if (!hlAdapter?.isConnected()) return [];
          return hlAdapter.getOpenOrders();
        },
        getArbitrumBalances: async () => {
          if (!arbAdapter?.isConnected()) return [];
          const balances: Array<{ token: string; balance: number }> = [];
          for (const token of RECONCILE_TOKENS) {
            try {
              const balance = await arbAdapter.getBalance(token);
              balances.push({ token, balance });
            } catch {
              // Skip tokens that fail (wallet may not be set in paper mode)
            }
          }
          return balances;
        },
        getAavePositions: async () => {
          if (!arbAdapter?.isConnected()) return [];
          try {
            const positions = await arbAdapter.getAavePositions();
            return positions.map(p => ({
              asset: p.asset,
              supplied: p.supplied,
              healthFactor: p.healthFactor,
            }));
          } catch {
            return [];
          }
        },
        sendAlert: async (severity, title, message) => {
          try {
            await ctx.adapter.send({
              chatId: ALERT_CONFIG.telegramChatId,
              text: `[${severity.toUpperCase()}] ${title}\n\n${message}`,
            });
          } catch (err) {
            ctx.log.error(`Failed to send reconciliation alert: ${err}`);
          }
        },
      });

      if (!result.isClean) {
        ctx.log.warn(`Reconciliation found ${result.discrepancies.length} discrepancies`);
      }
    } catch (err) {
      ctx.log.error(`Reconciliation cron error: ${err}`);
    }
  },
};
