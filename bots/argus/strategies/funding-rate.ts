/**
 * Argus Trading System — Funding Rate Arbitrage Strategy
 *
 * Delta-neutral funding rate capture:
 * - LONG spot on Arbitrum (WETH via Uniswap/Aave)
 * - SHORT perp on Hyperliquid
 * - Collect funding payments when rate is positive (shorts pay/receive)
 *
 * Entry criteria (ALL must be met):
 * - Funding rate elevated consistently over last 24h (MIN annualized >= 10%)
 * - Annualized rate >= MIN_FUNDING_ANNUALIZED (10%)
 * - Open interest >= FUNDING_ENTRY_MIN_OI ($50M)
 *
 * Exit criteria (ANY triggers exit):
 * - MAX annualized rate in last 16h drops below FUNDING_EXIT_MIN_ANNUALIZED (5%)
 * - All rates in last 16h are negative
 * - Basis divergence exceeds MAX_BASIS_DIVERGENCE (2%)
 * - Circuit breaker triggered
 *
 * CRITICAL: Both legs (spot + perp) must succeed atomically.
 * If one leg fails, immediately unwind the other + halt + alert.
 */

import type {
  FundingArbState,
  FundingEntrySignal,
  FundingRate,
  StrategyId,
} from '../lib/types.js';
import { SAFETY_LIMITS, STRATEGY_CONFIG, IS_PAPER_TRADING } from '../lib/config.js';
import { getDb, getMetadata, setMetadata, clearMetadata } from '../lib/db.js';
import { recordTradeIntent, markConfirmed, markFailed } from '../safety/trade-wal.js';
import { validateTrade, checkCircuitBreakers as checkPortfolioCircuitBreakers } from '../execution/risk.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FundingRateStrategyDeps {
  /** Place spot buy on Arbitrum */
  buySpot: (asset: string, amount: number) => Promise<{ success: boolean; txHash?: string; fillPrice?: number; error?: string }>;
  /** Sell spot on Arbitrum */
  sellSpot: (asset: string, amount: number) => Promise<{ success: boolean; txHash?: string; fillPrice?: number; error?: string }>;
  /** Open short perp on Hyperliquid */
  openShort: (asset: string, size: number, leverage: number) => Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }>;
  /** Close short perp on Hyperliquid */
  closeShort: (asset: string) => Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }>;
  /** Get current funding rate for asset */
  getFundingRate: (asset: string) => Promise<{ rate: number; annualized: number }>;
  /** Get current spot price */
  getSpotPrice: (asset: string) => Promise<number>;
  /** Get current perp price */
  getPerpPrice: (asset: string) => Promise<number>;
  /** Get current margin ratio */
  getMarginRatio: () => Promise<number>;
  /** Get current leverage */
  getCurrentLeverage: () => Promise<number>;
  /** Get open interest for asset */
  getOpenInterest: (asset: string) => Promise<number>;
  /** Get funding payment history */
  getFundingHistory: (asset: string, limit: number) => Promise<Array<{ timestamp: string; amount: number; rate: number }>>;
  /** Adjust perp size (positive = increase short, negative = reduce short) */
  adjustPerp: (asset: string, sizeDelta: number) => Promise<{ success: boolean; error?: string }>;
  /** Send alert */
  sendAlert: (severity: 'warning' | 'critical' | 'emergency', title: string, message: string) => Promise<void>;
}

// ─── Strategy ─────────────────────────────────────────────────────────────────

/**
 * Funding rate arbitrage strategy engine.
 *
 * Manages the full lifecycle of a delta-neutral funding rate position:
 * evaluate -> enter -> collect -> rebalance -> exit.
 *
 * Single-asset position at a time. evaluate() picks the best-qualifying
 * asset across ETH/BTC/SOL, not all simultaneously.
 */
export class FundingRateStrategy {
  private readonly strategyId: StrategyId = 'funding-rate';
  private readonly config = STRATEGY_CONFIG['funding-rate'];
  private state: FundingArbState | null = null;
  private deps: FundingRateStrategyDeps;
  private evaluating = false;
  private stateLoaded = false;

  constructor(deps: FundingRateStrategyDeps) {
    this.deps = deps;
  }

  // ─── State Persistence ──────────────────────────────────────────────────

  /**
   * Reconstruct strategy state from DB on startup/first evaluate.
   *
   * Checks position table for funding-rate positions:
   * - Both legs (long+short) present → reconstruct state
   * - One leg only → UNHEDGED alert + halt
   * - No legs → clean state (null)
   */
  async loadState(): Promise<void> {
    const db = getDb();

    const positions = db.prepare(
      "SELECT * FROM positions WHERE strategy = 'funding-rate'"
    ).all() as Array<{
      id: number; asset: string; protocol: string; side: string;
      size: number; entry_price: number;
    }>;

    if (positions.length === 0) {
      this.state = null;
      this.stateLoaded = true;
      return;
    }

    const longPos = positions.find(p => p.side === 'long');
    const shortPos = positions.find(p => p.side === 'short');

    // One leg only — orphaned position
    if ((longPos && !shortPos) || (!longPos && shortPos)) {
      const side = longPos ? 'long spot' : 'short perp';
      await this.deps.sendAlert(
        'emergency',
        'UNHEDGED POSITION DETECTED',
        `Orphaned ${side} position found for funding-rate strategy. Manual review required.`,
      );
      await this.haltStrategy();
      this.stateLoaded = true;
      return;
    }

    // Both legs — reconstruct state
    if (longPos && shortPos && longPos.asset === shortPos.asset) {
      const entryFundingRate = parseFloat(getMetadata(db, 'funding-rate', 'entryFundingRate') ?? '0');
      const collectedFunding = parseFloat(getMetadata(db, 'funding-rate', 'collectedFunding') ?? '0');

      // Get live data
      const currentFunding = await this.deps.getFundingRate(longPos.asset);
      const marginRatio = await this.deps.getMarginRatio();
      const leverage = await this.deps.getCurrentLeverage();
      const spotPrice = await this.deps.getSpotPrice(longPos.asset);
      const perpPrice = await this.deps.getPerpPrice(longPos.asset);
      const basisDivergence = Math.abs(spotPrice - perpPrice) / spotPrice;

      this.state = {
        isActive: true,
        spotAsset: longPos.asset,
        spotSize: longPos.size,
        perpSize: shortPos.size,
        spotChain: 'arbitrum',
        perpExchange: 'hyperliquid',
        entryFundingRate,
        currentFundingRate: currentFunding.annualized,
        collectedFunding,
        basisDivergence,
        effectiveLeverage: leverage,
        marginRatio,
      };

      console.error(`[FundingRateStrategy] loadState: reconstructed position for ${longPos.asset}`);
    }

    this.stateLoaded = true;
  }

  // ─── Evaluation ───────────────────────────────────────────────────────────

  /**
   * Analyze current funding rates and generate signals.
   *
   * For active positions: check exit conditions, then rebalance + collect.
   * For no position: find the best qualifying asset and enter.
   *
   * Uses mutex to prevent concurrent evaluate() calls from overlapping.
   */
  async evaluate(): Promise<void> {
    // Guard: strategy status
    const db = getDb();
    const strategyRow = db.prepare(
      'SELECT status FROM strategies WHERE id = ?'
    ).get(this.strategyId) as { status: string } | undefined;
    if (strategyRow && strategyRow.status !== 'active') {
      return;
    }

    // Guard: mutex
    if (this.evaluating) return;
    this.evaluating = true;

    try {
      // Load state on first call
      if (!this.stateLoaded) {
        await this.loadState();
      }

      console.error(`[FundingRateStrategy] evaluate: checking assets ${this.config.assets.join(', ')}`);

      // Active position — check exit conditions
      if (this.state?.isActive) {
        const asset = this.state.spotAsset;
        const { annualized } = await this.deps.getFundingRate(asset);

        // Update current rate in state
        this.state.currentFundingRate = annualized;

        // Check: MAX annualized in last 16h < exit threshold
        const maxRate = db.prepare(`
          SELECT MAX(annualized) as max_ann FROM funding_rates
          WHERE asset = ? AND timestamp > datetime('now', '-16 hours') AND exchange = 'hyperliquid'
        `).get(asset) as { max_ann: number | null };

        if (maxRate.max_ann !== null && maxRate.max_ann < SAFETY_LIMITS.FUNDING_EXIT_MIN_ANNUALIZED) {
          await this.exit('low_rate');
          return;
        }

        // Check: all rates in last 16h are negative
        const allRates = db.prepare(`
          SELECT annualized FROM funding_rates
          WHERE asset = ? AND timestamp > datetime('now', '-16 hours') AND exchange = 'hyperliquid'
        `).all(asset) as Array<{ annualized: number }>;

        if (allRates.length > 0 && allRates.every(r => r.annualized < 0)) {
          await this.exit('negative_funding');
          return;
        }

        // Check basis divergence
        const spotPrice = await this.deps.getSpotPrice(asset);
        const perpPrice = await this.deps.getPerpPrice(asset);
        const basisDivergence = Math.abs(spotPrice - perpPrice) / spotPrice;
        this.state.basisDivergence = basisDivergence;

        if (basisDivergence > SAFETY_LIMITS.MAX_BASIS_DIVERGENCE) {
          await this.exit('basis_divergence');
          return;
        }

        // No exit — rebalance + collect funding
        await this.rebalance();
        await this.collectFunding();
        return;
      }

      // No active position — scan for entry
      let bestSignal: FundingEntrySignal | null = null;

      for (const asset of this.config.assets) {
        const { rate, annualized } = await this.deps.getFundingRate(asset);

        console.error(
          `[FundingRateStrategy] ${asset}: rate=${(rate * 100).toFixed(4)}% 8h, annualized=${(annualized * 100).toFixed(1)}%`,
        );

        // Current rate must meet threshold
        if (annualized < SAFETY_LIMITS.MIN_FUNDING_ANNUALIZED) continue;

        // MIN annualized in last 24h must meet threshold (consistently elevated)
        const minRate = db.prepare(`
          SELECT MIN(annualized) as min_ann FROM funding_rates
          WHERE asset = ? AND timestamp > datetime('now', '-24 hours') AND exchange = 'hyperliquid'
        `).get(asset) as { min_ann: number | null };

        if (minRate.min_ann === null || minRate.min_ann < SAFETY_LIMITS.MIN_FUNDING_ANNUALIZED) continue;

        // Check OI threshold
        const oi = await this.deps.getOpenInterest(asset);
        if (oi < SAFETY_LIMITS.FUNDING_ENTRY_MIN_OI) continue;

        // Get prices
        const spotPrice = await this.deps.getSpotPrice(asset);
        const perpPrice = await this.deps.getPerpPrice(asset);

        // Calculate position size
        const strategyValueRow = db.prepare(
          'SELECT current_value FROM strategies WHERE id = ?'
        ).get(this.strategyId) as { current_value: number } | undefined;
        const strategyValue = strategyValueRow?.current_value ?? 0;
        const spotAllocationUsd = strategyValue * this.config.spotPct;
        const recommendedSize = spotPrice > 0 ? spotAllocationUsd / spotPrice : 0;

        if (recommendedSize <= 0) continue;

        const signal: FundingEntrySignal = {
          type: 'enter',
          asset,
          fundingRate8h: rate,
          annualizedRate: annualized,
          openInterest: oi,
          spotPrice,
          perpPrice,
          recommendedSize,
        };

        // Track the best qualifying asset (highest annualized rate)
        if (!bestSignal || annualized > bestSignal.annualizedRate) {
          bestSignal = signal;
        }
      }

      // Enter the best qualifying asset
      if (bestSignal) {
        if (IS_PAPER_TRADING) {
          console.error(`[FundingRateStrategy] PAPER: would enter ${bestSignal.asset} @ ${(bestSignal.annualizedRate * 100).toFixed(1)}%`);
          return;
        }
        await this.enter(bestSignal.asset, bestSignal);
      }
    } finally {
      this.evaluating = false;
    }
  }

  // ─── Entry ────────────────────────────────────────────────────────────────

  /**
   * Open a delta-neutral position: long spot + short perp.
   *
   * CRITICAL: Both legs are executed in parallel. If one succeeds and
   * the other fails, the successful leg is IMMEDIATELY unwound.
   * The strategy is then HALTED and an UNHEDGED EXPOSURE alert is sent.
   */
  async enter(asset: string, signal: FundingEntrySignal): Promise<void> {
    console.error(
      `[FundingRateStrategy] enter: ${asset} — rate=${(signal.annualizedRate * 100).toFixed(1)}%, size=${signal.recommendedSize}`,
    );

    // Guard: already in position
    if (this.state?.isActive) {
      console.error('[FundingRateStrategy] enter: already in position, skipping');
      return;
    }

    // Guard: strategy status
    const db = getDb();
    const strategyRow = db.prepare(
      'SELECT status, current_value FROM strategies WHERE id = ?'
    ).get(this.strategyId) as { status: string; current_value: number } | undefined;
    if (strategyRow && strategyRow.status !== 'active') return;

    // Validate leverage
    if (SAFETY_LIMITS.MAX_FUNDING_LEVERAGE < 1) {
      await this.deps.sendAlert('critical', 'Invalid leverage config', 'MAX_FUNDING_LEVERAGE < 1');
      return;
    }

    const spotSize = signal.recommendedSize;
    const perpSize = spotSize; // Delta-neutral: same notional
    const spotPrice = signal.spotPrice;
    const perpPrice = signal.perpPrice;

    // Pre-flight risk checks
    const tradeValue = spotSize * spotPrice;
    const strategyValue = strategyRow?.current_value ?? 0;
    const tradeCheck = validateTrade({
      strategy: this.strategyId,
      asset,
      size: tradeValue,
      strategyValue,
    });
    if (!tradeCheck.allowed) {
      console.error(`[FundingRateStrategy] enter blocked by validateTrade: ${tradeCheck.reason}`);
      return;
    }

    const cbCheck = checkPortfolioCircuitBreakers();
    if (!cbCheck.allowed) {
      console.error(`[FundingRateStrategy] enter blocked by circuit breaker: ${cbCheck.reason}`);
      return;
    }

    // Record both trade intents in WAL
    const spotWalId = recordTradeIntent({
      strategy: 'funding-rate',
      asset,
      protocol: 'wallet',
      direction: 'buy',
      size: String(spotSize),
      intentPrice: String(spotPrice),
    });

    const perpWalId = recordTradeIntent({
      strategy: 'funding-rate',
      asset,
      protocol: 'hyperliquid',
      direction: 'sell',
      size: String(perpSize),
      intentPrice: String(perpPrice),
    });

    // Execute both legs in parallel
    const [spotResult, perpResult] = await Promise.allSettled([
      this.deps.buySpot(asset, spotSize),
      this.deps.openShort(asset, perpSize, SAFETY_LIMITS.MAX_FUNDING_LEVERAGE),
    ]);

    const spotOk = spotResult.status === 'fulfilled' && spotResult.value.success;
    const perpOk = perpResult.status === 'fulfilled' && perpResult.value.success;

    // CASE A: Both succeeded
    if (spotOk && perpOk) {
      const spotFill = spotResult.value;
      const perpFill = perpResult.value;

      markConfirmed(spotWalId, {
        txHash: spotFill.txHash || '',
        fillPrice: String(spotFill.fillPrice ?? spotPrice),
        fillSize: String(spotSize),
      });
      markConfirmed(perpWalId, {
        txHash: perpFill.orderId || '',
        fillPrice: String(perpFill.fillPrice ?? perpPrice),
        fillSize: String(perpSize),
      });

      const actualSpotEntry = spotFill.fillPrice ?? spotPrice;
      const actualPerpEntry = perpFill.fillPrice ?? perpPrice;

      // Insert position rows
      db.prepare(`
        INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, opened_at, updated_at)
        VALUES ('funding-rate', ?, 'wallet', 'long', ?, ?, datetime('now'), datetime('now'))
      `).run(asset, spotSize, actualSpotEntry);

      db.prepare(`
        INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, opened_at, updated_at)
        VALUES ('funding-rate', ?, 'hyperliquid', 'short', ?, ?, datetime('now'), datetime('now'))
      `).run(asset, perpSize, actualPerpEntry);

      // Set strategy state
      this.state = {
        isActive: true,
        spotAsset: asset,
        spotSize,
        perpSize,
        spotChain: 'arbitrum',
        perpExchange: 'hyperliquid',
        entryFundingRate: signal.annualizedRate,
        currentFundingRate: signal.annualizedRate,
        collectedFunding: 0,
        basisDivergence: Math.abs(spotPrice - perpPrice) / spotPrice,
        effectiveLeverage: SAFETY_LIMITS.MAX_FUNDING_LEVERAGE,
        marginRatio: 1.0,
      };

      // Store metadata
      setMetadata(db, 'funding-rate', 'entryFundingRate', String(signal.annualizedRate));
      setMetadata(db, 'funding-rate', 'collectedFunding', '0');
      setMetadata(db, 'funding-rate', 'lastFundingCheckTimestamp', new Date().toISOString());
      setMetadata(db, 'funding-rate', 'entrySpotPrice', String(actualSpotEntry));
      setMetadata(db, 'funding-rate', 'entryPerpPrice', String(actualPerpEntry));

      await this.deps.sendAlert(
        'warning',
        'Funding Arb Entered',
        `${asset} @ ${(signal.annualizedRate * 100).toFixed(1)}% annualized, size=${spotSize.toFixed(4)}`,
      );
      return;
    }

    // CASE B: Spot succeeded, perp failed
    if (spotOk && !perpOk) {
      markConfirmed(spotWalId, {
        txHash: spotResult.value.txHash || '',
        fillPrice: String(spotResult.value.fillPrice ?? spotPrice),
        fillSize: String(spotSize),
      });
      const perpErr = perpResult.status === 'rejected' ? perpResult.reason?.message : perpResult.value?.error;
      markFailed(perpWalId, perpErr || 'Perp leg failed');

      // Unwind spot
      try {
        await this.deps.sellSpot(asset, spotSize);
      } catch {
        await this.deps.sendAlert(
          'emergency',
          'UNHEDGED EXPOSURE — MANUAL INTERVENTION REQUIRED',
          `Perp leg failed AND spot unwind failed for ${asset}. Position is UNHEDGED.`,
        );
        await this.haltStrategy();
        return;
      }

      await this.deps.sendAlert(
        'emergency',
        'UNHEDGED EXPOSURE',
        `Perp leg failed for ${asset}, spot unwound. Strategy halted.`,
      );
      await this.haltStrategy();
      return;
    }

    // CASE C: Perp succeeded, spot failed
    if (!spotOk && perpOk) {
      const spotErr = spotResult.status === 'rejected' ? spotResult.reason?.message : spotResult.value?.error;
      markFailed(spotWalId, spotErr || 'Spot leg failed');
      markConfirmed(perpWalId, {
        txHash: perpResult.value.orderId || '',
        fillPrice: String(perpResult.value.fillPrice ?? perpPrice),
        fillSize: String(perpSize),
      });

      // Unwind perp
      try {
        await this.deps.closeShort(asset);
      } catch {
        await this.deps.sendAlert(
          'emergency',
          'UNHEDGED EXPOSURE — MANUAL INTERVENTION REQUIRED',
          `Spot leg failed AND perp unwind failed for ${asset}. Position is UNHEDGED.`,
        );
        await this.haltStrategy();
        return;
      }

      await this.deps.sendAlert(
        'emergency',
        'UNHEDGED EXPOSURE',
        `Spot leg failed for ${asset}, perp unwound. Strategy halted.`,
      );
      await this.haltStrategy();
      return;
    }

    // CASE D: Both failed
    const spotErr = spotResult.status === 'rejected' ? spotResult.reason?.message : spotResult.value?.error;
    const perpErr = perpResult.status === 'rejected' ? perpResult.reason?.message : perpResult.value?.error;
    markFailed(spotWalId, spotErr || 'Spot leg failed');
    markFailed(perpWalId, perpErr || 'Perp leg failed');

    await this.deps.sendAlert(
      'warning',
      'Funding Arb Entry Failed',
      `Both legs failed for ${asset}. Spot: ${spotErr}. Perp: ${perpErr}`,
    );
    // No state change, no halt — can retry next evaluate cycle
  }

  // ─── Exit ─────────────────────────────────────────────────────────────────

  /**
   * Close the delta-neutral position: sell spot + close perp.
   *
   * Both legs executed in parallel. Same partial failure handling as enter().
   */
  async exit(reason: string): Promise<void> {
    console.error(`[FundingRateStrategy] exit: reason=${reason}`);

    if (!this.state?.isActive) {
      console.error('[FundingRateStrategy] exit: no active position to close');
      return;
    }

    const db = getDb();
    const { spotAsset, spotSize, perpSize } = this.state;

    // Get current prices for PnL calc
    const currentSpotPrice = await this.deps.getSpotPrice(spotAsset);
    const currentPerpPrice = await this.deps.getPerpPrice(spotAsset);

    // Record trade intents in WAL
    const spotWalId = recordTradeIntent({
      strategy: 'funding-rate',
      asset: spotAsset,
      protocol: 'wallet',
      direction: 'sell',
      size: String(spotSize),
      intentPrice: String(currentSpotPrice),
    });

    const perpWalId = recordTradeIntent({
      strategy: 'funding-rate',
      asset: spotAsset,
      protocol: 'hyperliquid',
      direction: 'buy',
      size: String(perpSize),
      intentPrice: String(currentPerpPrice),
    });

    // Execute both legs in parallel
    const [spotResult, perpResult] = await Promise.allSettled([
      this.deps.sellSpot(spotAsset, spotSize),
      this.deps.closeShort(spotAsset),
    ]);

    const spotOk = spotResult.status === 'fulfilled' && spotResult.value.success;
    const perpOk = perpResult.status === 'fulfilled' && perpResult.value.success;

    // Both succeeded
    if (spotOk && perpOk) {
      markConfirmed(spotWalId, {
        txHash: spotResult.value.txHash || '',
        fillPrice: String(spotResult.value.fillPrice ?? currentSpotPrice),
        fillSize: String(spotSize),
      });
      markConfirmed(perpWalId, {
        txHash: perpResult.value.orderId || '',
        fillPrice: String(perpResult.value.fillPrice ?? currentPerpPrice),
        fillSize: String(perpSize),
      });

      // Calculate PnL
      const entrySpotPrice = parseFloat(getMetadata(db, 'funding-rate', 'entrySpotPrice') ?? '0');
      const entryPerpPrice = parseFloat(getMetadata(db, 'funding-rate', 'entryPerpPrice') ?? '0');
      const spotPnl = (currentSpotPrice - entrySpotPrice) * spotSize;
      const perpPnl = (entryPerpPrice - currentPerpPrice) * perpSize;
      const fundingPnl = this.state.collectedFunding;
      const totalPnl = spotPnl + perpPnl + fundingPnl;

      // Update DB
      db.prepare(
        "UPDATE strategies SET total_pnl = total_pnl + ?, updated_at = datetime('now') WHERE id = 'funding-rate'"
      ).run(totalPnl);

      db.prepare("DELETE FROM positions WHERE strategy = 'funding-rate'").run();
      clearMetadata(db, 'funding-rate');

      this.state = null;

      await this.deps.sendAlert(
        'warning',
        'Funding Arb Exited',
        `${spotAsset} reason=${reason}, PnL=$${totalPnl.toFixed(2)} (spot=$${spotPnl.toFixed(2)} perp=$${perpPnl.toFixed(2)} funding=$${fundingPnl.toFixed(2)})`,
      );
      return;
    }

    // One or both failed — handle partial failure
    if (spotOk && !perpOk) {
      markConfirmed(spotWalId, {
        txHash: spotResult.value.txHash || '',
        fillPrice: String(spotResult.value.fillPrice ?? currentSpotPrice),
        fillSize: String(spotSize),
      });
      const perpErr = perpResult.status === 'rejected' ? perpResult.reason?.message : perpResult.value?.error;
      markFailed(perpWalId, perpErr || 'Perp close failed');

      await this.deps.sendAlert(
        'emergency',
        'UNHEDGED EXPOSURE — EXIT PARTIAL FAILURE',
        `Spot sold but perp close failed for ${spotAsset}. Manual intervention required. Error: ${perpErr}`,
      );
      await this.haltStrategy();
      return;
    }

    if (!spotOk && perpOk) {
      const spotErr = spotResult.status === 'rejected' ? spotResult.reason?.message : spotResult.value?.error;
      markFailed(spotWalId, spotErr || 'Spot sell failed');
      markConfirmed(perpWalId, {
        txHash: perpResult.value.orderId || '',
        fillPrice: String(perpResult.value.fillPrice ?? currentPerpPrice),
        fillSize: String(perpSize),
      });

      await this.deps.sendAlert(
        'emergency',
        'UNHEDGED EXPOSURE — EXIT PARTIAL FAILURE',
        `Perp closed but spot sell failed for ${spotAsset}. Manual intervention required. Error: ${spotErr}`,
      );
      await this.haltStrategy();
      return;
    }

    // Both failed
    const spotErr = spotResult.status === 'rejected' ? spotResult.reason?.message : spotResult.value?.error;
    const perpErr = perpResult.status === 'rejected' ? perpResult.reason?.message : perpResult.value?.error;
    markFailed(spotWalId, spotErr || 'Spot sell failed');
    markFailed(perpWalId, perpErr || 'Perp close failed');

    await this.deps.sendAlert(
      'emergency',
      'EXIT FAILED — MANUAL INTERVENTION REQUIRED',
      `Both exit legs failed for ${spotAsset}. Spot: ${spotErr}. Perp: ${perpErr}. Position still open.`,
    );
    await this.haltStrategy();
  }

  // ─── Rebalancing ──────────────────────────────────────────────────────────

  /**
   * Adjust position if leverage has drifted outside bounds.
   *
   * Uses adjustPerp dep to modify perp size without close+reopen gap.
   * Only warns on failure — position is still hedged, just suboptimal.
   */
  async rebalance(): Promise<void> {
    if (!this.state?.isActive) {
      return;
    }

    const leverage = await this.deps.getCurrentLeverage();
    console.error(`[FundingRateStrategy] rebalance: current leverage=${leverage.toFixed(2)}`);

    if (leverage >= SAFETY_LIMITS.REBALANCE_MIN_LEVERAGE && leverage <= SAFETY_LIMITS.REBALANCE_MAX_LEVERAGE) {
      return; // Within bounds
    }

    const currentPerpPrice = await this.deps.getPerpPrice(this.state.spotAsset);
    const currentNotional = this.state.perpSize * currentPerpPrice;
    const margin = leverage > 0 ? currentNotional / leverage : currentNotional;
    const targetNotional = margin * 2.0; // Target leverage = 2x
    const targetPerpSize = currentPerpPrice > 0 ? targetNotional / currentPerpPrice : this.state.perpSize;
    const sizeDelta = targetPerpSize - this.state.perpSize;

    if (Math.abs(sizeDelta) < 0.001) return; // Negligible

    const db = getDb();

    // Record WAL entry
    const walId = recordTradeIntent({
      strategy: 'funding-rate',
      asset: this.state.spotAsset,
      protocol: 'hyperliquid',
      direction: sizeDelta > 0 ? 'sell' : 'buy',
      size: String(Math.abs(sizeDelta)),
      intentPrice: String(currentPerpPrice),
    });

    const result = await this.deps.adjustPerp(this.state.spotAsset, sizeDelta);

    if (result.success) {
      markConfirmed(walId, {
        txHash: '',
        fillPrice: String(currentPerpPrice),
        fillSize: String(Math.abs(sizeDelta)),
      });

      const oldSize = this.state.perpSize;
      this.state.perpSize = targetPerpSize;
      this.state.effectiveLeverage = 2.0;

      // Update perp position row
      db.prepare(`
        UPDATE positions SET size = ?, updated_at = datetime('now')
        WHERE strategy = 'funding-rate' AND side = 'short'
      `).run(targetPerpSize);

      console.error(
        `[FundingRateStrategy] rebalanced: leverage ${leverage.toFixed(2)} → ~2.0, perpSize ${oldSize.toFixed(4)} → ${targetPerpSize.toFixed(4)}`,
      );
    } else {
      markFailed(walId, result.error || 'adjustPerp failed');
      await this.deps.sendAlert(
        'warning',
        'Rebalance Failed',
        `Failed to adjust perp for ${this.state.spotAsset}: ${result.error}. Leverage at ${leverage.toFixed(2)}.`,
      );
      // Do NOT halt — position is still hedged, just suboptimal leverage
    }
  }

  // ─── Funding Collection ───────────────────────────────────────────────────

  /**
   * Track funding payments received from Hyperliquid.
   *
   * Queries funding history since last check, sums new payments,
   * updates collectedFunding and strategy total_pnl.
   */
  async collectFunding(): Promise<void> {
    if (!this.state?.isActive) {
      return;
    }

    const db = getDb();
    const lastCheck = getMetadata(db, 'funding-rate', 'lastFundingCheckTimestamp')
      ?? new Date(0).toISOString();

    const payments = await this.deps.getFundingHistory(this.state.spotAsset, 100);

    // Filter to payments after last check
    const lastCheckTime = new Date(lastCheck).getTime();
    const newPayments = payments.filter(p => new Date(p.timestamp).getTime() > lastCheckTime);

    const newFunding = newPayments.reduce((sum, p) => sum + p.amount, 0);

    if (newFunding !== 0) {
      this.state.collectedFunding += newFunding;

      db.prepare(
        "UPDATE strategies SET total_pnl = total_pnl + ?, updated_at = datetime('now') WHERE id = 'funding-rate'"
      ).run(newFunding);

      setMetadata(db, 'funding-rate', 'collectedFunding', String(this.state.collectedFunding));

      console.error(`[FundingRateStrategy] collectFunding: +$${newFunding.toFixed(4)}, total=$${this.state.collectedFunding.toFixed(4)}`);
    }

    // Update watermark
    setMetadata(db, 'funding-rate', 'lastFundingCheckTimestamp', new Date().toISOString());
  }

  // ─── State ────────────────────────────────────────────────────────────────

  /**
   * Get the current state of the funding rate strategy.
   */
  getState(): FundingArbState | null {
    return this.state;
  }

  // ─── Circuit Breakers ─────────────────────────────────────────────────────

  /**
   * Check strategy-specific circuit breakers.
   *
   * If breached, triggers exit and halts strategy.
   */
  async checkCircuitBreakers(): Promise<void> {
    if (!this.state?.isActive) {
      return;
    }

    const spotPrice = await this.deps.getSpotPrice(this.state.spotAsset);
    const perpPrice = await this.deps.getPerpPrice(this.state.spotAsset);
    const basisDivergence = Math.abs(spotPrice - perpPrice) / spotPrice;

    if (basisDivergence > SAFETY_LIMITS.MAX_BASIS_DIVERGENCE) {
      await this.deps.sendAlert(
        'critical',
        'Basis Divergence Circuit Breaker',
        `Basis divergence ${(basisDivergence * 100).toFixed(2)}% exceeds threshold ${SAFETY_LIMITS.MAX_BASIS_DIVERGENCE * 100}%. Exiting position.`,
      );
      await this.exit('basis_divergence');
      await this.haltStrategy();
      return;
    }

    const marginRatio = await this.deps.getMarginRatio();
    if (marginRatio < SAFETY_LIMITS.MIN_MARGIN_RATIO) {
      await this.deps.sendAlert(
        'critical',
        'Margin Ratio Circuit Breaker',
        `Margin ratio ${(marginRatio * 100).toFixed(1)}% below threshold ${SAFETY_LIMITS.MIN_MARGIN_RATIO * 100}%. Exiting position.`,
      );
      await this.exit('low_margin');
      await this.haltStrategy();
      return;
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

    this.state = null;
    console.error('[FundingRateStrategy] HALTED');
  }
}
