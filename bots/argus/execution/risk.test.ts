/**
 * Tests for Argus risk validation module.
 *
 * Tests the pure validation functions (checkSlippage, checkMarginRatio,
 * checkHealthFactor) which don't depend on DB state.
 */
import { describe, it, expect } from 'vitest';
import { SAFETY_LIMITS } from '../lib/config.js';

// We test the pure functions directly — the ones that don't call getDb().
// For DB-dependent functions (validateTrade, checkCircuitBreakers), we'd need
// to mock the DB module, which we'll do in integration tests.

describe('checkSlippage (inline implementation)', () => {
  // Replicating the pure logic from risk.ts to test without DB dependency
  function checkSlippage(expectedPrice: number, actualPrice: number) {
    if (expectedPrice <= 0 || actualPrice <= 0) {
      return { allowed: false, reason: 'Invalid prices' };
    }
    const slippage = Math.abs(actualPrice - expectedPrice) / expectedPrice;
    if (slippage > SAFETY_LIMITS.MAX_SLIPPAGE_PCT) {
      return { allowed: false, reason: `Slippage ${(slippage * 100).toFixed(3)}%` };
    }
    return { allowed: true };
  }

  it('allows zero slippage', () => {
    expect(checkSlippage(2500, 2500).allowed).toBe(true);
  });

  it('allows slippage within 0.3%', () => {
    // 0.2% slippage
    expect(checkSlippage(2500, 2505).allowed).toBe(true);
  });

  it('rejects slippage above 0.3%', () => {
    // 0.4% slippage
    expect(checkSlippage(2500, 2510).allowed).toBe(false);
  });

  it('rejects negative prices', () => {
    expect(checkSlippage(-1, 2500).allowed).toBe(false);
    expect(checkSlippage(2500, -1).allowed).toBe(false);
  });

  it('rejects zero prices', () => {
    expect(checkSlippage(0, 2500).allowed).toBe(false);
    expect(checkSlippage(2500, 0).allowed).toBe(false);
  });

  it('handles both positive and negative slippage', () => {
    // Price went up
    expect(checkSlippage(2500, 2510).allowed).toBe(false);
    // Price went down
    expect(checkSlippage(2500, 2490).allowed).toBe(false);
  });
});

describe('checkMarginRatio (inline implementation)', () => {
  function checkMarginRatio(currentMargin: number) {
    if (currentMargin < SAFETY_LIMITS.MIN_MARGIN_RATIO) {
      return { allowed: false, reason: `Margin too low: ${currentMargin}` };
    }
    return { allowed: true };
  }

  it('allows margin at exactly 40%', () => {
    expect(checkMarginRatio(0.40).allowed).toBe(true);
  });

  it('allows margin above 40%', () => {
    expect(checkMarginRatio(0.50).allowed).toBe(true);
    expect(checkMarginRatio(0.95).allowed).toBe(true);
  });

  it('rejects margin below 40%', () => {
    expect(checkMarginRatio(0.39).allowed).toBe(false);
    expect(checkMarginRatio(0.10).allowed).toBe(false);
  });
});

describe('checkHealthFactor (inline implementation)', () => {
  function checkHealthFactor(factor: number) {
    if (factor < SAFETY_LIMITS.MIN_HEALTH_FACTOR) {
      return { allowed: false, reason: `Health factor too low: ${factor}` };
    }
    return { allowed: true };
  }

  it('allows health factor at exactly 2.0', () => {
    expect(checkHealthFactor(2.0).allowed).toBe(true);
  });

  it('allows health factor above 2.0', () => {
    expect(checkHealthFactor(3.5).allowed).toBe(true);
    expect(checkHealthFactor(10.0).allowed).toBe(true);
  });

  it('rejects health factor below 2.0', () => {
    expect(checkHealthFactor(1.99).allowed).toBe(false);
    expect(checkHealthFactor(1.0).allowed).toBe(false);
    expect(checkHealthFactor(0.5).allowed).toBe(false);
  });
});

describe('Trade size validation (inline implementation)', () => {
  function validateTradeSize(size: number, strategyValue: number) {
    if (strategyValue <= 0) return { allowed: true };
    const tradePct = size / strategyValue;
    if (tradePct > SAFETY_LIMITS.MAX_SINGLE_TRADE_PCT) {
      return { allowed: false, reason: `Trade ${(tradePct * 100).toFixed(1)}% > max ${SAFETY_LIMITS.MAX_SINGLE_TRADE_PCT * 100}%` };
    }
    return { allowed: true };
  }

  it('allows trade within 3% of strategy value', () => {
    // $1,000 trade on $40,000 strategy = 2.5%
    expect(validateTradeSize(1000, 40000).allowed).toBe(true);
  });

  it('allows trade at exactly 3%', () => {
    // $1,200 on $40,000 = 3.0%
    expect(validateTradeSize(1200, 40000).allowed).toBe(true);
  });

  it('rejects trade above 3% of strategy value', () => {
    // $1,500 on $40,000 = 3.75%
    expect(validateTradeSize(1500, 40000).allowed).toBe(false);
  });

  it('allows any size when strategy has no value', () => {
    expect(validateTradeSize(10000, 0).allowed).toBe(true);
  });
});

describe('Emergency slippage tiers', () => {
  it('tiers are [0.3%, 1%, 3%]', () => {
    expect(SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS).toEqual([0.003, 0.01, 0.03]);
  });

  it('routine slippage limit is below first emergency tier', () => {
    expect(SAFETY_LIMITS.MAX_SLIPPAGE_PCT).toBeLessThanOrEqual(SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS[0]);
  });
});

describe('Funding rate arb limits', () => {
  it('entry requires 10%+ annualized', () => {
    expect(SAFETY_LIMITS.MIN_FUNDING_ANNUALIZED).toBe(0.10);
  });

  it('exit below 5% annualized', () => {
    expect(SAFETY_LIMITS.FUNDING_EXIT_MIN_ANNUALIZED).toBe(0.05);
  });

  it('entry requires 3+ consecutive elevated periods', () => {
    expect(SAFETY_LIMITS.FUNDING_ENTRY_MIN_PERIODS).toBe(3);
  });

  it('exit after 2 consecutive negative periods', () => {
    expect(SAFETY_LIMITS.FUNDING_EXIT_NEGATIVE_PERIODS).toBe(2);
  });

  it('max basis divergence is 2%', () => {
    expect(SAFETY_LIMITS.MAX_BASIS_DIVERGENCE).toBe(0.02);
  });

  it('rebalance leverage range is 1.6x-2.5x', () => {
    expect(SAFETY_LIMITS.REBALANCE_MIN_LEVERAGE).toBe(1.6);
    expect(SAFETY_LIMITS.REBALANCE_MAX_LEVERAGE).toBe(2.5);
  });
});
