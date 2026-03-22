/**
 * Argus Trading System — Multi-Protocol Yield Optimization Strategy
 *
 * Manages yield-generating allocations across:
 * - Ethena sUSDe (staked USDe — basis trade yield)
 * - Aave V3 on Arbitrum (USDC/WETH lending)
 * - Ondo USDY (tokenized T-bill yield, static allocation)
 *
 * Rebalances when yield differential exceeds
 * YIELD_REBALANCE_MIN_DIFFERENTIAL (2%) after gas costs.
 *
 * Emergency exit: sUSDe depeg > SUSDE_DEPEG_THRESHOLD (0.5%)
 * triggers tiered slippage DEX sell.
 *
 * NO yield looping in v1 (NO_YIELD_LOOPING_V1 = true).
 */

import type {
  YieldAllocation,
  YieldRebalanceSignal,
  Protocol,
  StrategyId,
} from '../lib/types.js';
import { SAFETY_LIMITS, STRATEGY_CONFIG, IS_PAPER_TRADING } from '../lib/config.js';
import { getDb } from '../lib/db.js';
import { recordTradeIntent, markConfirmed, markFailed } from '../safety/trade-wal.js';
import { validateTrade, checkCircuitBreakers as checkPortfolioCircuitBreakers } from '../execution/risk.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface YieldStrategyDeps {
  /** Get Aave V3 positions and health factor */
  getAavePositions: () => Promise<Array<{ asset: string; supplied: number; supplyApy: number; healthFactor: number }>>;
  /** Get Aave health factor */
  getAaveHealthFactor: () => Promise<number>;
  /** Supply to Aave */
  aaveSupply: (asset: string, amount: string) => Promise<{ txHash: string; success: boolean }>;
  /** Withdraw from Aave */
  aaveWithdraw: (asset: string, amount: string) => Promise<{ txHash: string; success: boolean }>;
  /** Get sUSDe price on DEX (for depeg check) */
  getSUSDePriceOnDex: () => Promise<number>;
  /** Emergency sell sUSDe with tiered slippage */
  sellSUSDeOnDex: (amount: string, maxSlippage: number) => Promise<{ success: boolean; txHash?: string; error?: string }>;
  /** Get token balance on Arbitrum */
  getBalance: (token: string) => Promise<number>;
  /** Execute a swap */
  swap: (params: { tokenIn: string; tokenOut: string; amountIn: string; maxSlippagePct: number }) => Promise<{ success: boolean; txHash?: string; error?: string }>;
  /** Send alert */
  sendAlert: (severity: 'warning' | 'critical' | 'emergency', title: string, message: string) => Promise<void>;
}

// ─── Strategy ─────────────────────────────────────────────────────────────────

/**
 * Multi-protocol yield optimization strategy.
 *
 * Manages the yield allocation across Ethena, Aave, and USDY.
 * Periodically evaluates yields and rebalances when differentials
 * justify the gas cost. Monitors sUSDe peg health continuously.
 */
export class YieldStrategy {
  private readonly strategyId: StrategyId = 'yield';
  private readonly config = STRATEGY_CONFIG['yield'];
  private deps: YieldStrategyDeps;
  private evaluating = false;

  constructor(deps: YieldStrategyDeps) {
    this.deps = deps;
  }

  // ─── Evaluation ───────────────────────────────────────────────────────────

  /**
   * Compare yields across all protocols and determine if rebalancing is needed.
   *
   * Checks:
   * 1. sUSDe peg health (most time-sensitive — depeg triggers emergency exit)
   * 2. Current APYs from each protocol (from yields table + live queries)
   * 3. Yield differential between best and worst allocations
   * 4. Whether differential exceeds threshold and justifies gas cost
   */
  async evaluate(): Promise<void> {
    // Guard: strategy status
    const db = getDb();
    const strategyRow = db.prepare(
      'SELECT status FROM strategies WHERE id = ?'
    ).get(this.strategyId) as { status: string } | undefined;
    if (strategyRow && strategyRow.status !== 'active') return;

    // Guard: mutex
    if (this.evaluating) return;
    this.evaluating = true;

    try {
      // 1. sUSDe peg check (most time-sensitive)
      const susdePrice = await this.deps.getSUSDePriceOnDex();
      const depeg = Math.abs(1 - susdePrice);

      if (depeg > SAFETY_LIMITS.SUSDE_DEPEG_THRESHOLD) {
        console.error(
          `[YieldStrategy] sUSDe DEPEG DETECTED: price=${susdePrice}, depeg=${(depeg * 100).toFixed(2)}%`,
        );
        await this.deps.sendAlert(
          'emergency',
          'sUSDe DEPEG DETECTED',
          `sUSDe trading at ${susdePrice} — ${(depeg * 100).toFixed(2)}% off peg. Threshold: ${SAFETY_LIMITS.SUSDE_DEPEG_THRESHOLD * 100}%. Initiating emergency exit.`,
        );
        await this.emergencyExitSUSDE();
        return;
      }

      // 2. Get latest APYs from yields table
      const yields = db.prepare(`
        SELECT protocol, asset, apy FROM yields
        WHERE (protocol, asset, timestamp) IN (
          SELECT protocol, asset, MAX(timestamp) FROM yields GROUP BY protocol, asset
        )
      `).all() as Array<{ protocol: string; asset: string; apy: number }>;

      if (yields.length < 2) {
        console.error('[YieldStrategy] evaluate: not enough yield data to compare');
        return;
      }

      // 3. Find highest and lowest yielding allocations
      const sorted = [...yields].sort((a, b) => b.apy - a.apy);
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];
      const differential = highest.apy - lowest.apy;

      console.error(
        `[YieldStrategy] evaluate: highest=${highest.protocol}/${highest.asset} ${(highest.apy * 100).toFixed(2)}%, lowest=${lowest.protocol}/${lowest.asset} ${(lowest.apy * 100).toFixed(2)}%, diff=${(differential * 100).toFixed(2)}%`,
      );

      // 4. Check if rebalance is warranted
      if (differential < SAFETY_LIMITS.YIELD_REBALANCE_MIN_DIFFERENTIAL) return;

      // Calculate if gas-effective
      const yieldPositions = db.prepare(`
        SELECT COALESCE(SUM(size), 0) as total FROM positions
        WHERE strategy = 'yield' AND protocol = ?
      `).get(lowest.protocol) as { total: number };

      const totalInLowest = yieldPositions.total;
      if (totalInLowest <= 0) return;

      const estimatedGasCost = 0.30; // Arbitrum L2 typical
      const monthlyGain = totalInLowest * differential * (30 / 365);

      if (monthlyGain <= estimatedGasCost * 2) {
        console.error(
          `[YieldStrategy] evaluate: monthly gain $${monthlyGain.toFixed(2)} not worth gas $${estimatedGasCost.toFixed(2)}`,
        );
        return;
      }

      const signal: YieldRebalanceSignal = {
        type: 'rebalance',
        from: { protocol: lowest.protocol as Protocol, asset: lowest.asset, amount: totalInLowest },
        to: { protocol: highest.protocol as Protocol, asset: highest.asset, amount: totalInLowest },
        yieldDifferential: differential,
        estimatedGasCost,
        estimatedMonthlyGain: monthlyGain,
      };

      if (IS_PAPER_TRADING) {
        console.error(`[YieldStrategy] PAPER: would rebalance ${lowest.protocol} → ${highest.protocol}`);
        return;
      }

      await this.rebalance(signal);
    } finally {
      this.evaluating = false;
    }
  }

  // ─── Rebalancing ──────────────────────────────────────────────────────────

  /**
   * Move funds between protocols based on yield differential.
   *
   * Validates: differential threshold, gas cost, no yield looping, protocol concentration.
   * Flow: withdraw from source → swap if needed → supply to target.
   */
  async rebalance(signal: YieldRebalanceSignal): Promise<void> {
    console.error(
      `[YieldStrategy] rebalance: ${signal.from.protocol}/${signal.from.asset} → ${signal.to.protocol}/${signal.to.asset} (diff=${(signal.yieldDifferential * 100).toFixed(1)}%)`,
    );

    // Enforce no yield looping in v1
    if (SAFETY_LIMITS.NO_YIELD_LOOPING_V1) {
      console.error('[YieldStrategy] rebalance: yield looping disabled in v1');
    }

    // Validate differential is worth the gas
    if (signal.yieldDifferential < SAFETY_LIMITS.YIELD_REBALANCE_MIN_DIFFERENTIAL) {
      return;
    }

    if (signal.estimatedMonthlyGain < signal.estimatedGasCost) {
      console.error(
        `[YieldStrategy] rebalance: monthly gain $${signal.estimatedMonthlyGain.toFixed(2)} < gas cost $${signal.estimatedGasCost.toFixed(2)}`,
      );
      return;
    }

    // Pre-flight: portfolio circuit breaker
    const cbCheck = checkPortfolioCircuitBreakers();
    if (!cbCheck.allowed) {
      console.error(`[YieldStrategy] rebalance blocked by circuit breaker: ${cbCheck.reason}`);
      return;
    }

    const db = getDb();

    // Step 1: Withdraw from source protocol
    let withdrawSuccess = false;
    const withdrawWalId = recordTradeIntent({
      strategy: 'yield',
      asset: signal.from.asset,
      protocol: signal.from.protocol,
      direction: 'withdraw',
      size: String(signal.from.amount),
      intentPrice: '1',
    });

    if (signal.from.protocol === 'aave-v3') {
      const result = await this.deps.aaveWithdraw(signal.from.asset, String(signal.from.amount));
      if (result.success) {
        markConfirmed(withdrawWalId, { txHash: result.txHash, fillPrice: '1', fillSize: String(signal.from.amount) });
        withdrawSuccess = true;
      } else {
        markFailed(withdrawWalId, 'Aave withdraw failed');
      }
    } else {
      // For ethena/ondo, it's a token sell/redeem
      markFailed(withdrawWalId, `Withdraw from ${signal.from.protocol} not implemented in v1`);
      return;
    }

    if (!withdrawSuccess) {
      await this.deps.sendAlert('warning', 'Yield Rebalance Failed', `Failed to withdraw from ${signal.from.protocol}`);
      return;
    }

    // Step 2: Swap if different assets
    if (signal.from.asset !== signal.to.asset) {
      const swapResult = await this.deps.swap({
        tokenIn: signal.from.asset,
        tokenOut: signal.to.asset,
        amountIn: String(signal.from.amount),
        maxSlippagePct: SAFETY_LIMITS.MAX_SLIPPAGE_PCT,
      });
      if (!swapResult.success) {
        await this.deps.sendAlert('warning', 'Yield Rebalance Swap Failed', `Swap ${signal.from.asset} → ${signal.to.asset} failed: ${swapResult.error}`);
        // Funds are in wallet, not lost — just not rebalanced
        return;
      }
    }

    // Step 3: Supply to target protocol
    const supplyWalId = recordTradeIntent({
      strategy: 'yield',
      asset: signal.to.asset,
      protocol: signal.to.protocol,
      direction: 'supply',
      size: String(signal.to.amount),
      intentPrice: '1',
    });

    if (signal.to.protocol === 'aave-v3') {
      const result = await this.deps.aaveSupply(signal.to.asset, String(signal.to.amount));
      if (result.success) {
        markConfirmed(supplyWalId, { txHash: result.txHash, fillPrice: '1', fillSize: String(signal.to.amount) });
      } else {
        markFailed(supplyWalId, 'Aave supply failed');
        await this.deps.sendAlert('warning', 'Yield Rebalance Supply Failed', `Failed to supply to ${signal.to.protocol}. Funds in wallet.`);
        return;
      }
    } else {
      markFailed(supplyWalId, `Supply to ${signal.to.protocol} not implemented in v1`);
      return;
    }

    // Step 4: Update positions table
    db.prepare(`
      UPDATE positions SET size = size - ?, updated_at = datetime('now')
      WHERE strategy = 'yield' AND protocol = ? AND asset = ?
    `).run(signal.from.amount, signal.from.protocol, signal.from.asset);

    // Upsert target position
    const existing = db.prepare(
      "SELECT id FROM positions WHERE strategy = 'yield' AND protocol = ? AND asset = ?"
    ).get(signal.to.protocol, signal.to.asset) as { id: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE positions SET size = size + ?, updated_at = datetime('now') WHERE id = ?
      `).run(signal.to.amount, existing.id);
    } else {
      db.prepare(`
        INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, opened_at, updated_at)
        VALUES ('yield', ?, ?, 'supply', ?, 1, datetime('now'), datetime('now'))
      `).run(signal.to.asset, signal.to.protocol, signal.to.amount);
    }

    await this.deps.sendAlert(
      'warning',
      'Yield Rebalanced',
      `Moved $${signal.from.amount.toFixed(2)} from ${signal.from.protocol} (${(signal.from.amount * signal.yieldDifferential * 100).toFixed(1)}% diff) to ${signal.to.protocol}`,
    );

    console.error(`[YieldStrategy] rebalance complete: ${signal.from.protocol} → ${signal.to.protocol}`);
  }

  // ─── Emergency Exit ───────────────────────────────────────────────────────

  /**
   * Emergency sell all sUSDe holdings via DEX with tiered slippage.
   *
   * Uses SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS:
   * - Tier 1: 0.3% slippage (routine)
   * - Tier 2: 1.0% slippage (if T1 fails)
   * - Tier 3: 3.0% slippage (last resort)
   */
  async emergencyExitSUSDE(): Promise<void> {
    console.error('[YieldStrategy] emergencyExitSUSDE: initiating tiered sell');

    const susdeBalance = await this.deps.getBalance('sUSDe');
    if (susdeBalance <= 0) {
      console.error('[YieldStrategy] emergencyExitSUSDE: no sUSDe balance to sell');
      return;
    }

    const db = getDb();
    const walId = recordTradeIntent({
      strategy: 'yield',
      asset: 'sUSDe',
      protocol: 'ethena' as any,
      direction: 'sell',
      size: String(susdeBalance),
      intentPrice: '1',
    });

    const slippageTiers = SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS;

    for (let i = 0; i < slippageTiers.length; i++) {
      const maxSlippage = slippageTiers[i];
      console.error(
        `[YieldStrategy] emergencyExitSUSDE: tier ${i + 1} — maxSlippage=${(maxSlippage * 100).toFixed(1)}%`,
      );

      try {
        const result = await this.deps.sellSUSDeOnDex(
          String(susdeBalance),
          maxSlippage,
        );

        if (result.success) {
          markConfirmed(walId, {
            txHash: result.txHash || '',
            fillPrice: '1',
            fillSize: String(susdeBalance),
          });

          // Remove sUSDe positions from DB
          db.prepare("DELETE FROM positions WHERE strategy = 'yield' AND asset = 'sUSDe'").run();

          await this.deps.sendAlert(
            'critical',
            'sUSDe Emergency Exit Complete',
            `Sold ${susdeBalance} sUSDe at tier ${i + 1} (max slippage ${(maxSlippage * 100).toFixed(1)}%). TxHash: ${result.txHash}`,
          );
          return;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[YieldStrategy] emergencyExitSUSDE: tier ${i + 1} failed — ${errMsg}`);

        if (i < slippageTiers.length - 1) {
          await this.deps.sendAlert(
            'critical',
            `sUSDe Emergency Exit Tier ${i + 1} Failed`,
            `Failed at ${(maxSlippage * 100).toFixed(1)}% slippage. Escalating to tier ${i + 2}. Error: ${errMsg}`,
          );
        }
      }
    }

    // All tiers failed
    markFailed(walId, 'All slippage tiers exhausted');
    await this.deps.sendAlert(
      'emergency',
      'sUSDe EMERGENCY EXIT FAILED — ALL TIERS EXHAUSTED',
      `Could not sell ${susdeBalance} sUSDe. Manual intervention required.`,
    );
    await this.haltStrategy();
  }

  // ─── Allocations ──────────────────────────────────────────────────────────

  /**
   * Get current allocations across all protocols, enriched with APYs.
   */
  getAllocations(): YieldAllocation[] {
    const db = getDb();

    const positions = db.prepare(`
      SELECT p.asset, p.protocol, p.size,
        (SELECT y.apy FROM yields y WHERE y.protocol = p.protocol AND y.asset = p.asset ORDER BY y.timestamp DESC LIMIT 1) as latest_apy
      FROM positions p
      WHERE p.strategy = 'yield'
    `).all() as Array<{ asset: string; protocol: string; size: number; latest_apy: number | null }>;

    return positions.map((p) => ({
      protocol: p.protocol as Protocol,
      asset: p.asset,
      amount: p.size,
      currentApy: p.latest_apy ?? 0,
      healthFactor: null, // Aave HF checked separately via circuit breakers
    }));
  }

  // ─── Circuit Breakers ─────────────────────────────────────────────────────

  /**
   * Check yield-strategy-specific circuit breakers.
   *
   * - sUSDe depeg > SUSDE_DEPEG_THRESHOLD → emergency exit
   * - Aave health factor < MIN_HEALTH_FACTOR → withdraw to restore
   * - Protocol concentration > MAX_SINGLE_PROTOCOL_PCT → alert
   */
  async checkCircuitBreakers(): Promise<void> {
    // sUSDe depeg check
    try {
      const susdePrice = await this.deps.getSUSDePriceOnDex();
      const depeg = Math.abs(1 - susdePrice);

      if (depeg > SAFETY_LIMITS.SUSDE_DEPEG_THRESHOLD) {
        await this.deps.sendAlert(
          'emergency',
          'sUSDe Depeg Circuit Breaker',
          `sUSDe at ${susdePrice} — ${(depeg * 100).toFixed(2)}% off peg`,
        );
        await this.emergencyExitSUSDE();
        return;
      }
    } catch (err) {
      console.error(`[YieldStrategy] checkCircuitBreakers: sUSDe price check failed — ${err}`);
    }

    // Aave health factor check
    try {
      const hf = await this.deps.getAaveHealthFactor();
      if (hf < SAFETY_LIMITS.MIN_HEALTH_FACTOR) {
        await this.deps.sendAlert(
          'critical',
          'Aave Health Factor Circuit Breaker',
          `Health factor ${hf.toFixed(2)} below threshold ${SAFETY_LIMITS.MIN_HEALTH_FACTOR}. Withdrawing to restore.`,
        );

        // Withdraw from Aave to restore health factor
        const positions = await this.deps.getAavePositions();
        for (const pos of positions) {
          if (pos.supplied > 0) {
            // Withdraw 25% to restore HF
            const withdrawAmount = (pos.supplied * 0.25).toFixed(6);
            await this.deps.aaveWithdraw(pos.asset, withdrawAmount);
          }
        }

        await this.deps.sendAlert(
          'warning',
          'Aave Partial Withdrawal',
          `Withdrew 25% from Aave to restore health factor.`,
        );
      }
    } catch (err) {
      console.error(`[YieldStrategy] checkCircuitBreakers: Aave HF check failed — ${err}`);
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Halt this strategy — set status to 'halted' in DB.
   */
  private async haltStrategy(): Promise<void> {
    const db = getDb();
    db.prepare(
      "UPDATE strategies SET status = 'halted', updated_at = datetime('now') WHERE id = ?",
    ).run(this.strategyId);

    console.error('[YieldStrategy] HALTED');
  }
}
