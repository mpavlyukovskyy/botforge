/**
 * Argus Trading System — Pre-Flight Risk Validation
 *
 * Every trade MUST pass these checks before execution.
 * These are the last line of defense after strategy logic.
 *
 * Functions return { allowed: boolean; reason?: string } —
 * callers MUST abort if allowed === false.
 *
 * Import this module and call the relevant checks before
 * submitting any order or on-chain transaction.
 */

import { SAFETY_LIMITS } from '../lib/config.js';
import {
  getDb,
  getTradeCount,
  getPortfolioValue,
  get24hDrawdown,
} from '../lib/db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

interface TradeValidationParams {
  strategy: string;
  asset: string;
  size: number;
  /** Current allocation value of the strategy */
  strategyValue: number;
}

// ─── Trade Validation ─────────────────────────────────────────────────────────

/**
 * Validate a trade against SAFETY_LIMITS before execution.
 *
 * Checks:
 * - Trade size does not exceed MAX_SINGLE_TRADE_PCT of strategy allocation
 * - Cash reserve remains above MIN_CASH_RESERVE after trade
 * - Trade rate limits are not exceeded
 *
 * @param params - Trade parameters to validate
 * @returns Whether the trade is allowed
 */
export function validateTrade(params: TradeValidationParams): RiskCheckResult {
  const { strategy, asset, size, strategyValue } = params;

  // Check trade size vs strategy allocation
  if (strategyValue > 0) {
    const tradePct = size / strategyValue;
    if (tradePct > SAFETY_LIMITS.MAX_SINGLE_TRADE_PCT) {
      return {
        allowed: false,
        reason: `Trade size ${(tradePct * 100).toFixed(1)}% exceeds MAX_SINGLE_TRADE_PCT (${SAFETY_LIMITS.MAX_SINGLE_TRADE_PCT * 100}%) for strategy ${strategy} on ${asset}`,
      };
    }
  }

  // Check cash reserve
  const db = getDb();
  const portfolioValue = getPortfolioValue(db);
  if (portfolioValue > 0) {
    const reserveStmt = db.prepare(
      "SELECT current_value FROM strategies WHERE id = 'reserve'"
    ).get() as { current_value: number } | undefined;

    const reserveValue = reserveStmt?.current_value ?? 0;
    const reserveRatio = reserveValue / portfolioValue;
    if (reserveRatio < SAFETY_LIMITS.MIN_CASH_RESERVE) {
      return {
        allowed: false,
        reason: `Cash reserve ${(reserveRatio * 100).toFixed(1)}% below MIN_CASH_RESERVE (${SAFETY_LIMITS.MIN_CASH_RESERVE * 100}%). Cannot execute trade.`,
      };
    }
  }

  // Check rate limits
  const rateLimitCheck = checkTradeRateLimit();
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck;
  }

  return { allowed: true };
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/**
 * Check trade rate limits (MAX_TRADES_PER_HOUR and MAX_TRADES_PER_DAY).
 *
 * Queries the trade_wal table for recent submitted/confirmed trades.
 */
export function checkTradeRateLimit(): RiskCheckResult {
  const db = getDb();

  const hourlyCount = getTradeCount(db, 1);
  if (hourlyCount >= SAFETY_LIMITS.MAX_TRADES_PER_HOUR) {
    return {
      allowed: false,
      reason: `Hourly trade limit reached: ${hourlyCount}/${SAFETY_LIMITS.MAX_TRADES_PER_HOUR}`,
    };
  }

  const dailyCount = getTradeCount(db, 24);
  if (dailyCount >= SAFETY_LIMITS.MAX_TRADES_PER_DAY) {
    return {
      allowed: false,
      reason: `Daily trade limit reached: ${dailyCount}/${SAFETY_LIMITS.MAX_TRADES_PER_DAY}`,
    };
  }

  return { allowed: true };
}

// ─── Gas Price ────────────────────────────────────────────────────────────────

/**
 * Check if current gas price is below MAX_GAS_GWEI.
 *
 * Queries the chain RPC for current fee data and compares against the limit.
 * If fee data is unavailable, defaults to allowed (permissive on RPC failure).
 *
 * @param provider - Ethers JsonRpcProvider for the target chain
 * @returns Whether gas is acceptable
 */
export async function checkGasPrice(
  provider: { getFeeData: () => Promise<{ gasPrice: bigint | null }> },
): Promise<RiskCheckResult> {
  const feeData = await provider.getFeeData();
  if (!feeData.gasPrice) {
    return { allowed: true }; // Can't determine, allow
  }
  const gasPriceGwei = Number(feeData.gasPrice) / 1e9;
  if (gasPriceGwei > SAFETY_LIMITS.MAX_GAS_GWEI) {
    return {
      allowed: false,
      reason: `Gas price ${gasPriceGwei.toFixed(1)} gwei > MAX_GAS_GWEI (${SAFETY_LIMITS.MAX_GAS_GWEI})`,
    };
  }
  return { allowed: true };
}

// ─── Slippage ─────────────────────────────────────────────────────────────────

/**
 * Check if slippage between expected and actual price is within tolerance.
 *
 * @param expectedPrice - The price we expected to get
 * @param actualPrice - The price we actually got (or would get from quote)
 * @returns Whether slippage is acceptable
 */
export function checkSlippage(
  expectedPrice: number,
  actualPrice: number,
): RiskCheckResult {
  if (expectedPrice <= 0 || actualPrice <= 0) {
    return {
      allowed: false,
      reason: `Invalid prices for slippage check: expected=${expectedPrice}, actual=${actualPrice}`,
    };
  }

  const slippage = Math.abs(actualPrice - expectedPrice) / expectedPrice;

  if (slippage > SAFETY_LIMITS.MAX_SLIPPAGE_PCT) {
    return {
      allowed: false,
      reason: `Slippage ${(slippage * 100).toFixed(3)}% exceeds MAX_SLIPPAGE_PCT (${SAFETY_LIMITS.MAX_SLIPPAGE_PCT * 100}%). Expected=${expectedPrice}, Actual=${actualPrice}`,
    };
  }

  return { allowed: true };
}

// ─── Circuit Breakers ─────────────────────────────────────────────────────────

/**
 * Check portfolio-level and strategy-level circuit breakers.
 *
 * Checks:
 * - Portfolio 24h drawdown vs PORTFOLIO_WARNING_DRAWDOWN and PORTFOLIO_HALT_DRAWDOWN
 * - Per-strategy drawdown vs STRATEGY_HALT_DRAWDOWN
 *
 * If HALT thresholds are breached, the calling code should halt all strategies.
 */
export function checkCircuitBreakers(): RiskCheckResult {
  const db = getDb();

  // Portfolio-level drawdown
  const drawdown = get24hDrawdown(db);

  if (drawdown >= SAFETY_LIMITS.PORTFOLIO_HALT_DRAWDOWN) {
    return {
      allowed: false,
      reason: `CIRCUIT BREAKER: Portfolio drawdown ${(drawdown * 100).toFixed(2)}% exceeds HALT threshold (${SAFETY_LIMITS.PORTFOLIO_HALT_DRAWDOWN * 100}%). ALL STRATEGIES MUST HALT.`,
    };
  }

  if (drawdown >= SAFETY_LIMITS.PORTFOLIO_WARNING_DRAWDOWN) {
    // Warning — still allowed but should be logged/alerted
    console.error(
      `[risk] WARNING: Portfolio drawdown ${(drawdown * 100).toFixed(2)}% exceeds warning threshold (${SAFETY_LIMITS.PORTFOLIO_WARNING_DRAWDOWN * 100}%)`,
    );
  }

  // Per-strategy drawdown
  const strategies = db.prepare(`
    SELECT id, total_pnl, allocation_pct FROM strategies
    WHERE status = 'active'
  `).all() as Array<{ id: string; total_pnl: number; allocation_pct: number }>;

  const portfolioValue = getPortfolioValue(db);

  for (const s of strategies) {
    if (portfolioValue <= 0) continue;
    const strategyAllocation = portfolioValue * s.allocation_pct;
    if (strategyAllocation <= 0) continue;

    const strategyDrawdown = Math.abs(Math.min(0, s.total_pnl)) / strategyAllocation;
    if (strategyDrawdown >= SAFETY_LIMITS.STRATEGY_HALT_DRAWDOWN) {
      return {
        allowed: false,
        reason: `CIRCUIT BREAKER: Strategy '${s.id}' drawdown ${(strategyDrawdown * 100).toFixed(2)}% exceeds HALT threshold (${SAFETY_LIMITS.STRATEGY_HALT_DRAWDOWN * 100}%).`,
      };
    }
  }

  return { allowed: true };
}

// ─── Funding Rate Arb Checks ────────────────────────────────────────────────

/**
 * Check margin ratio for funding rate arbitrage.
 *
 * Margin must remain above MIN_MARGIN_RATIO to avoid liquidation risk.
 *
 * @param currentMargin - Current margin ratio (0-1 scale)
 */
export function checkMarginRatio(currentMargin: number): RiskCheckResult {
  if (currentMargin < SAFETY_LIMITS.MIN_MARGIN_RATIO) {
    return {
      allowed: false,
      reason: `Margin ratio ${(currentMargin * 100).toFixed(1)}% below MIN_MARGIN_RATIO (${SAFETY_LIMITS.MIN_MARGIN_RATIO * 100}%). Must rebalance or reduce position.`,
    };
  }

  return { allowed: true };
}

// ─── Aave Health Factor ───────────────────────────────────────────────────────

/**
 * Check Aave health factor against conservative threshold.
 *
 * Health factor < 1.0 triggers liquidation.
 * We maintain MIN_HEALTH_FACTOR (2.0) for safety.
 *
 * @param factor - Current health factor from Aave
 */
export function checkHealthFactor(factor: number): RiskCheckResult {
  if (factor < SAFETY_LIMITS.MIN_HEALTH_FACTOR) {
    return {
      allowed: false,
      reason: `Aave health factor ${factor.toFixed(2)} below MIN_HEALTH_FACTOR (${SAFETY_LIMITS.MIN_HEALTH_FACTOR}). Must withdraw or add collateral.`,
    };
  }

  return { allowed: true };
}

// ─── Protocol Concentration ───────────────────────────────────────────────────

/**
 * Check that a single protocol does not exceed MAX_SINGLE_PROTOCOL_PCT
 * of total portfolio value.
 *
 * @param protocol - Protocol name to check
 */
export function checkProtocolConcentration(protocol: string): RiskCheckResult {
  const db = getDb();
  const portfolioValue = getPortfolioValue(db);

  if (portfolioValue <= 0) {
    return { allowed: true }; // No portfolio to check against
  }

  const protocolValue = db.prepare(`
    SELECT COALESCE(SUM(size * COALESCE(current_price, entry_price)), 0) as value
    FROM positions
    WHERE protocol = ?
  `).get(protocol) as { value: number };

  const concentration = protocolValue.value / portfolioValue;

  if (concentration > SAFETY_LIMITS.MAX_SINGLE_PROTOCOL_PCT) {
    return {
      allowed: false,
      reason: `Protocol '${protocol}' concentration ${(concentration * 100).toFixed(1)}% exceeds MAX_SINGLE_PROTOCOL_PCT (${SAFETY_LIMITS.MAX_SINGLE_PROTOCOL_PCT * 100}%).`,
    };
  }

  return { allowed: true };
}
