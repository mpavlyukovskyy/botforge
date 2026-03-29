/**
 * Tests for Argus config module — safety limits and contract allowlist.
 */
import { describe, it, expect } from 'vitest';
import {
  SAFETY_LIMITS,
  CONTRACT_ALLOWLIST,
  STRATEGY_CONFIG,
  isAllowlistedAddress,
} from './config.js';

describe('SAFETY_LIMITS', () => {
  it('MAX_SINGLE_TRADE_PCT is 3%', () => {
    expect(SAFETY_LIMITS.MAX_SINGLE_TRADE_PCT).toBe(0.03);
  });

  it('MAX_FUNDING_LEVERAGE is 2x', () => {
    expect(SAFETY_LIMITS.MAX_FUNDING_LEVERAGE).toBe(2);
  });

  it('MIN_MARGIN_RATIO is 40%', () => {
    expect(SAFETY_LIMITS.MIN_MARGIN_RATIO).toBe(0.40);
  });

  it('MIN_HEALTH_FACTOR is 2.0', () => {
    expect(SAFETY_LIMITS.MIN_HEALTH_FACTOR).toBe(2.0);
  });

  it('MIN_CASH_RESERVE is 20%', () => {
    expect(SAFETY_LIMITS.MIN_CASH_RESERVE).toBe(0.20);
  });

  it('EMERGENCY_SLIPPAGE_TIERS are ascending', () => {
    const tiers = SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS;
    expect(tiers.length).toBe(3);
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]).toBeGreaterThan(tiers[i - 1]);
    }
  });

  it('KILL_SWITCH_EXEMPT is true', () => {
    expect(SAFETY_LIMITS.KILL_SWITCH_EXEMPT).toBe(true);
  });

  it('MAX_TRADES_PER_HOUR is 5', () => {
    expect(SAFETY_LIMITS.MAX_TRADES_PER_HOUR).toBe(5);
  });

  it('MAX_TRADES_PER_DAY is 20', () => {
    expect(SAFETY_LIMITS.MAX_TRADES_PER_DAY).toBe(20);
  });

  it('NO_YIELD_LOOPING_V1 is true', () => {
    expect(SAFETY_LIMITS.NO_YIELD_LOOPING_V1).toBe(true);
  });
});

describe('STRATEGY_CONFIG', () => {
  it('allocations sum to 100%', () => {
    const total =
      STRATEGY_CONFIG['funding-rate'].allocationPct +
      STRATEGY_CONFIG['yield'].allocationPct +
      STRATEGY_CONFIG['reserve'].allocationPct;
    expect(total).toBeCloseTo(1.0);
  });

  it('funding-rate split sums to 100%', () => {
    const fr = STRATEGY_CONFIG['funding-rate'];
    expect(fr.spotPct + fr.marginPct + fr.bufferPct).toBeCloseTo(1.0);
  });

  it('yield split sums to 100%', () => {
    const y = STRATEGY_CONFIG['yield'];
    expect(y.staticPct + y.activePct).toBeCloseTo(1.0);
  });

  it('ondo-equities is disabled by default', () => {
    expect(STRATEGY_CONFIG['ondo-equities'].enabled).toBe(false);
  });
});

describe('CONTRACT_ALLOWLIST', () => {
  it('has arbitrum contracts', () => {
    expect(CONTRACT_ALLOWLIST.arbitrum.WETH).toBeDefined();
    expect(CONTRACT_ALLOWLIST.arbitrum.USDC).toBeDefined();
    expect(CONTRACT_ALLOWLIST.arbitrum.AAVE_POOL).toBeDefined();
    expect(CONTRACT_ALLOWLIST.arbitrum.UNISWAP_ROUTER).toBeDefined();
  });

  it('has ethereum contracts', () => {
    expect(CONTRACT_ALLOWLIST.ethereum.ONDO_TOKEN).toBeDefined();
    expect(CONTRACT_ALLOWLIST.ethereum.CHAINLINK_ETH_USD).toBeDefined();
  });

  it('all addresses are 42 characters (0x + 40 hex)', () => {
    for (const chain of ['arbitrum', 'ethereum'] as const) {
      for (const [name, addr] of Object.entries(CONTRACT_ALLOWLIST[chain])) {
        expect(addr, `${chain}.${name}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });
});

describe('isAllowlistedAddress', () => {
  it('returns true for known Arbitrum WETH address', () => {
    expect(isAllowlistedAddress('arbitrum', CONTRACT_ALLOWLIST.arbitrum.WETH)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAllowlistedAddress('arbitrum', CONTRACT_ALLOWLIST.arbitrum.WETH.toLowerCase())).toBe(true);
    expect(isAllowlistedAddress('arbitrum', CONTRACT_ALLOWLIST.arbitrum.WETH.toUpperCase())).toBe(true);
  });

  it('returns false for unknown address', () => {
    expect(isAllowlistedAddress('arbitrum', '0x0000000000000000000000000000000000000000')).toBe(false);
  });

  it('returns false for wrong chain', () => {
    // WETH is on arbitrum, not ethereum
    expect(isAllowlistedAddress('ethereum', CONTRACT_ALLOWLIST.arbitrum.WETH)).toBe(false);
  });
});
