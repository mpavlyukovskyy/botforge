/**
 * Tests for Argus Yield Optimization Strategy.
 *
 * Uses mock deps (DI pattern) and in-memory SQLite for isolated,
 * deterministic testing of all strategy methods.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SAFETY_LIMITS } from '../lib/config.js';
import type { YieldStrategyDeps } from './yield.js';

// ─── Test DB Setup ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trade_wal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      strategy TEXT NOT NULL,
      asset TEXT NOT NULL,
      protocol TEXT NOT NULL,
      direction TEXT NOT NULL,
      size TEXT NOT NULL,
      intent_price TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      fill_price TEXT,
      fill_size TEXT,
      error TEXT,
      confirmed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_trade_wal_status ON trade_wal(status);

    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      allocation_pct REAL NOT NULL,
      current_value REAL DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      asset TEXT NOT NULL,
      protocol TEXT NOT NULL,
      side TEXT NOT NULL,
      size REAL NOT NULL,
      entry_price REAL NOT NULL,
      current_price REAL,
      unrealized_pnl REAL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy);

    CREATE TABLE IF NOT EXISTS yields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      protocol TEXT NOT NULL,
      asset TEXT NOT NULL,
      apy REAL NOT NULL,
      tvl REAL,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS strategy_metadata (
      strategy TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (strategy, key)
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      channels TEXT NOT NULL
    );

    INSERT INTO schema_version (version) VALUES (2);
  `);

  // Insert yield strategy
  db.prepare(`
    INSERT INTO strategies (id, status, allocation_pct, current_value, total_pnl, updated_at)
    VALUES ('yield', 'active', 0.30, 75000, 0, datetime('now'))
  `).run();

  // Reserve strategy for cash reserve checks
  db.prepare(`
    INSERT INTO strategies (id, status, allocation_pct, current_value, total_pnl, updated_at)
    VALUES ('reserve', 'active', 0.20, 50000, 0, datetime('now'))
  `).run();

  return db;
}

// ─── Mock Deps ────────────────────────────────────────────────────────────────

function createMockDeps(overrides?: Partial<YieldStrategyDeps>): YieldStrategyDeps {
  return {
    getAavePositions: vi.fn().mockResolvedValue([
      { asset: 'USDC', supplied: 10000, supplyApy: 0.04, healthFactor: 3.0 },
    ]),
    getAaveHealthFactor: vi.fn().mockResolvedValue(3.0),
    aaveSupply: vi.fn().mockResolvedValue({ txHash: '0xsupply', success: true }),
    aaveWithdraw: vi.fn().mockResolvedValue({ txHash: '0xwithdraw', success: true }),
    getSUSDePriceOnDex: vi.fn().mockResolvedValue(1.0),
    sellSUSDeOnDex: vi.fn().mockResolvedValue({ success: true, txHash: '0xsell' }),
    getBalance: vi.fn().mockResolvedValue(0),
    swap: vi.fn().mockResolvedValue({ success: true, txHash: '0xswap' }),
    sendAlert: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Seed Helpers ─────────────────────────────────────────────────────────────

function seedYields(db: Database.Database, entries: Array<{ protocol: string; asset: string; apy: number }>) {
  for (const e of entries) {
    db.prepare(
      "INSERT INTO yields (timestamp, protocol, asset, apy, source) VALUES (datetime('now'), ?, ?, ?, 'test')"
    ).run(e.protocol, e.asset, e.apy);
  }
}

function seedPosition(db: Database.Database, protocol: string, asset: string, size: number) {
  db.prepare(`
    INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, opened_at, updated_at)
    VALUES ('yield', ?, ?, 'supply', ?, 1, datetime('now'), datetime('now'))
  `).run(asset, protocol, size);
}

// ─── Module Mocks ─────────────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../lib/db.js', () => ({
  getDb: () => testDb,
  getMetadata: (db: any, strategy: string, key: string) => {
    const result = db.prepare(
      'SELECT value FROM strategy_metadata WHERE strategy = ? AND key = ?'
    ).get(strategy, key) as { value: string } | undefined;
    return result?.value ?? null;
  },
  setMetadata: (db: any, strategy: string, key: string, value: string) => {
    db.prepare(`
      INSERT INTO strategy_metadata (strategy, key, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(strategy, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(strategy, key, value);
  },
  clearMetadata: (db: any, strategy: string) => {
    db.prepare('DELETE FROM strategy_metadata WHERE strategy = ?').run(strategy);
  },
}));

vi.mock('../safety/trade-wal.js', () => {
  let walId = 0;
  return {
    recordTradeIntent: vi.fn(() => ++walId),
    markConfirmed: vi.fn(),
    markFailed: vi.fn(),
    executeWithWal: vi.fn(),
  };
});

vi.mock('../execution/risk.js', () => ({
  validateTrade: vi.fn(() => ({ allowed: true })),
  checkCircuitBreakers: vi.fn(() => ({ allowed: true })),
  checkGasPrice: vi.fn().mockResolvedValue({ allowed: true }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('YieldStrategy', () => {
  let YieldStrategy: any;

  beforeEach(async () => {
    testDb = createTestDb();
    vi.clearAllMocks();
    const mod = await import('./yield.js');
    YieldStrategy = mod.YieldStrategy;
  });

  afterEach(() => {
    testDb.close();
  });

  // ─── evaluate() ───────────────────────────────────────────────────────────

  describe('evaluate()', () => {
    it('should return early when strategy is not active', async () => {
      testDb.prepare("UPDATE strategies SET status = 'halted' WHERE id = 'yield'").run();
      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.evaluate();

      expect(deps.getSUSDePriceOnDex).not.toHaveBeenCalled();
    });

    it('should trigger emergency exit on sUSDe depeg', async () => {
      const deps = createMockDeps({
        getSUSDePriceOnDex: vi.fn().mockResolvedValue(0.99), // 1% depeg > 0.5% threshold
        getBalance: vi.fn().mockResolvedValue(5000), // sUSDe balance
      });
      const strategy = new YieldStrategy(deps);

      await strategy.evaluate();

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'emergency',
        expect.stringContaining('DEPEG'),
        expect.any(String),
      );
      expect(deps.sellSUSDeOnDex).toHaveBeenCalled();
    });

    it('should not rebalance when yield differential is below threshold', async () => {
      seedYields(testDb, [
        { protocol: 'aave-v3', asset: 'USDC', apy: 0.04 },
        { protocol: 'ethena', asset: 'sUSDe', apy: 0.05 }, // 1% diff < 2% threshold
      ]);
      seedPosition(testDb, 'aave-v3', 'USDC', 10000);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.evaluate();

      expect(deps.aaveWithdraw).not.toHaveBeenCalled();
    });

    it('should trigger rebalance when yield differential exceeds threshold', async () => {
      seedYields(testDb, [
        { protocol: 'aave-v3', asset: 'USDC', apy: 0.03 },
        { protocol: 'ethena', asset: 'sUSDe', apy: 0.12 }, // 9% diff > 2% threshold
      ]);
      seedPosition(testDb, 'aave-v3', 'USDC', 10000);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.evaluate();

      // Rebalance from aave-v3 → ethena requires Aave withdraw
      expect(deps.aaveWithdraw).toHaveBeenCalled();
    });

    it('should skip rebalance when monthly gain does not justify gas', async () => {
      seedYields(testDb, [
        { protocol: 'aave-v3', asset: 'USDC', apy: 0.03 },
        { protocol: 'ethena', asset: 'sUSDe', apy: 0.055 }, // 2.5% diff > threshold
      ]);
      // Very small position — monthly gain won't justify gas
      seedPosition(testDb, 'aave-v3', 'USDC', 5);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.evaluate();

      expect(deps.aaveWithdraw).not.toHaveBeenCalled();
    });

    it('should prevent concurrent evaluate calls (mutex)', async () => {
      seedYields(testDb, [
        { protocol: 'aave-v3', asset: 'USDC', apy: 0.03 },
        { protocol: 'ethena', asset: 'sUSDe', apy: 0.12 },
      ]);
      seedPosition(testDb, 'aave-v3', 'USDC', 10000);

      const deps = createMockDeps({
        getSUSDePriceOnDex: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(1.0), 50)),
        ),
      });
      const strategy = new YieldStrategy(deps);

      // Call twice simultaneously
      const [r1, r2] = await Promise.allSettled([
        strategy.evaluate(),
        strategy.evaluate(),
      ]);

      // First call gets the sUSDe price, second is blocked by mutex
      expect(deps.getSUSDePriceOnDex).toHaveBeenCalledTimes(1);
    });

    it('should return when not enough yield data', async () => {
      // Only one yield entry — need at least 2
      seedYields(testDb, [
        { protocol: 'aave-v3', asset: 'USDC', apy: 0.04 },
      ]);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.evaluate();

      expect(deps.aaveWithdraw).not.toHaveBeenCalled();
    });
  });

  // ─── rebalance() ──────────────────────────────────────────────────────────

  describe('rebalance()', () => {
    it('should withdraw from source and supply to target on Aave→Aave', async () => {
      seedPosition(testDb, 'aave-v3', 'USDC', 5000);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.rebalance({
        type: 'rebalance',
        from: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        to: { protocol: 'aave-v3', asset: 'WETH', amount: 5000 },
        yieldDifferential: 0.05,
        estimatedGasCost: 0.30,
        estimatedMonthlyGain: 20,
      });

      expect(deps.aaveWithdraw).toHaveBeenCalledWith('USDC', '5000');
      expect(deps.swap).toHaveBeenCalled(); // Different assets require swap
      expect(deps.aaveSupply).toHaveBeenCalledWith('WETH', '5000');
    });

    it('should skip swap when source and target are the same asset', async () => {
      seedPosition(testDb, 'aave-v3', 'USDC', 5000);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.rebalance({
        type: 'rebalance',
        from: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        to: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        yieldDifferential: 0.05,
        estimatedGasCost: 0.30,
        estimatedMonthlyGain: 20,
      });

      expect(deps.swap).not.toHaveBeenCalled();
    });

    it('should not rebalance when differential is below threshold', async () => {
      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.rebalance({
        type: 'rebalance',
        from: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        to: { protocol: 'ethena', asset: 'sUSDe', amount: 5000 },
        yieldDifferential: 0.01, // Below 2% threshold
        estimatedGasCost: 0.30,
        estimatedMonthlyGain: 2,
      });

      expect(deps.aaveWithdraw).not.toHaveBeenCalled();
    });

    it('should not rebalance when monthly gain < gas cost', async () => {
      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.rebalance({
        type: 'rebalance',
        from: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        to: { protocol: 'aave-v3', asset: 'WETH', amount: 5000 },
        yieldDifferential: 0.05,
        estimatedGasCost: 10,
        estimatedMonthlyGain: 5, // Less than gas cost
      });

      expect(deps.aaveWithdraw).not.toHaveBeenCalled();
    });

    it('should alert on withdraw failure', async () => {
      const deps = createMockDeps({
        aaveWithdraw: vi.fn().mockResolvedValue({ txHash: '', success: false }),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.rebalance({
        type: 'rebalance',
        from: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        to: { protocol: 'aave-v3', asset: 'WETH', amount: 5000 },
        yieldDifferential: 0.05,
        estimatedGasCost: 0.30,
        estimatedMonthlyGain: 20,
      });

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('Failed'),
        expect.any(String),
      );
      expect(deps.aaveSupply).not.toHaveBeenCalled();
    });

    it('should alert on supply failure (funds stay in wallet)', async () => {
      const deps = createMockDeps({
        aaveSupply: vi.fn().mockResolvedValue({ txHash: '', success: false }),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.rebalance({
        type: 'rebalance',
        from: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        to: { protocol: 'aave-v3', asset: 'USDC', amount: 5000 },
        yieldDifferential: 0.05,
        estimatedGasCost: 0.30,
        estimatedMonthlyGain: 20,
      });

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('Supply Failed'),
        expect.any(String),
      );
    });

    it('should update positions table on successful rebalance', async () => {
      seedPosition(testDb, 'aave-v3', 'USDC', 5000);
      seedPosition(testDb, 'aave-v3', 'WETH', 1000);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      await strategy.rebalance({
        type: 'rebalance',
        from: { protocol: 'aave-v3', asset: 'USDC', amount: 3000 },
        to: { protocol: 'aave-v3', asset: 'WETH', amount: 3000 },
        yieldDifferential: 0.05,
        estimatedGasCost: 0.30,
        estimatedMonthlyGain: 20,
      });

      // Source position should have decreased
      const sourcePos = testDb.prepare(
        "SELECT size FROM positions WHERE strategy = 'yield' AND protocol = 'aave-v3' AND asset = 'USDC'"
      ).get() as { size: number };
      expect(sourcePos.size).toBe(2000); // 5000 - 3000

      // Target position should have increased
      const targetPos = testDb.prepare(
        "SELECT size FROM positions WHERE strategy = 'yield' AND protocol = 'aave-v3' AND asset = 'WETH'"
      ).get() as { size: number };
      expect(targetPos.size).toBe(4000); // 1000 + 3000
    });
  });

  // ─── emergencyExitSUSDE() ─────────────────────────────────────────────────

  describe('emergencyExitSUSDE()', () => {
    it('should sell sUSDe with tiered slippage', async () => {
      const deps = createMockDeps({
        getBalance: vi.fn().mockResolvedValue(10000),
        sellSUSDeOnDex: vi.fn().mockResolvedValue({ success: true, txHash: '0xexit' }),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.emergencyExitSUSDE();

      // Should succeed at tier 1
      expect(deps.sellSUSDeOnDex).toHaveBeenCalledTimes(1);
      expect(deps.sellSUSDeOnDex).toHaveBeenCalledWith('10000', SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS[0]);
    });

    it('should escalate to tier 2 when tier 1 fails', async () => {
      let callCount = 0;
      const deps = createMockDeps({
        getBalance: vi.fn().mockResolvedValue(10000),
        sellSUSDeOnDex: vi.fn().mockImplementation(async (_amount: string, slippage: number) => {
          callCount++;
          if (callCount === 1) return { success: false, error: 'insufficient liquidity' };
          return { success: true, txHash: '0xexit2' };
        }),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.emergencyExitSUSDE();

      expect(deps.sellSUSDeOnDex).toHaveBeenCalledTimes(2);
      expect(deps.sellSUSDeOnDex).toHaveBeenNthCalledWith(1, '10000', SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS[0]);
      expect(deps.sellSUSDeOnDex).toHaveBeenNthCalledWith(2, '10000', SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS[1]);
    });

    it('should halt strategy when all tiers fail', async () => {
      const deps = createMockDeps({
        getBalance: vi.fn().mockResolvedValue(10000),
        sellSUSDeOnDex: vi.fn().mockRejectedValue(new Error('all tiers fail')),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.emergencyExitSUSDE();

      expect(deps.sellSUSDeOnDex).toHaveBeenCalledTimes(3); // All 3 tiers
      expect(deps.sendAlert).toHaveBeenCalledWith(
        'emergency',
        expect.stringContaining('ALL TIERS'),
        expect.any(String),
      );

      // Strategy should be halted
      const row = testDb.prepare("SELECT status FROM strategies WHERE id = 'yield'").get() as { status: string };
      expect(row.status).toBe('halted');
    });

    it('should no-op when sUSDe balance is zero', async () => {
      const deps = createMockDeps({
        getBalance: vi.fn().mockResolvedValue(0),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.emergencyExitSUSDE();

      expect(deps.sellSUSDeOnDex).not.toHaveBeenCalled();
    });

    it('should remove sUSDe positions from DB on success', async () => {
      seedPosition(testDb, 'ethena', 'sUSDe', 10000);

      const deps = createMockDeps({
        getBalance: vi.fn().mockResolvedValue(10000),
        sellSUSDeOnDex: vi.fn().mockResolvedValue({ success: true, txHash: '0xexit' }),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.emergencyExitSUSDE();

      const positions = testDb.prepare(
        "SELECT * FROM positions WHERE strategy = 'yield' AND asset = 'sUSDe'"
      ).all();
      expect(positions).toHaveLength(0);
    });
  });

  // ─── getAllocations() ─────────────────────────────────────────────────────

  describe('getAllocations()', () => {
    it('should return positions enriched with APYs', () => {
      seedPosition(testDb, 'aave-v3', 'USDC', 10000);
      seedPosition(testDb, 'ethena', 'sUSDe', 5000);
      seedYields(testDb, [
        { protocol: 'aave-v3', asset: 'USDC', apy: 0.04 },
        { protocol: 'ethena', asset: 'sUSDe', apy: 0.10 },
      ]);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      const allocations = strategy.getAllocations();

      expect(allocations).toHaveLength(2);
      expect(allocations.find((a: any) => a.protocol === 'aave-v3')?.currentApy).toBe(0.04);
      expect(allocations.find((a: any) => a.protocol === 'ethena')?.currentApy).toBe(0.10);
    });

    it('should default to 0 APY when no yield data exists', () => {
      seedPosition(testDb, 'aave-v3', 'USDC', 10000);

      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      const allocations = strategy.getAllocations();

      expect(allocations).toHaveLength(1);
      expect(allocations[0].currentApy).toBe(0);
    });

    it('should return empty array when no positions exist', () => {
      const deps = createMockDeps();
      const strategy = new YieldStrategy(deps);

      const allocations = strategy.getAllocations();

      expect(allocations).toHaveLength(0);
    });
  });

  // ─── checkCircuitBreakers() ───────────────────────────────────────────────

  describe('checkCircuitBreakers()', () => {
    it('should trigger emergency exit on sUSDe depeg', async () => {
      const deps = createMockDeps({
        getSUSDePriceOnDex: vi.fn().mockResolvedValue(0.98), // 2% depeg
        getBalance: vi.fn().mockResolvedValue(5000),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.checkCircuitBreakers();

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'emergency',
        expect.stringContaining('Depeg Circuit Breaker'),
        expect.any(String),
      );
      expect(deps.sellSUSDeOnDex).toHaveBeenCalled();
    });

    it('should withdraw from Aave when health factor is low', async () => {
      const deps = createMockDeps({
        getAaveHealthFactor: vi.fn().mockResolvedValue(1.5), // Below 2.0 threshold
        getAavePositions: vi.fn().mockResolvedValue([
          { asset: 'USDC', supplied: 10000, supplyApy: 0.04, healthFactor: 1.5 },
        ]),
      });
      const strategy = new YieldStrategy(deps);

      await strategy.checkCircuitBreakers();

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'critical',
        expect.stringContaining('Health Factor'),
        expect.any(String),
      );
      // Should withdraw 25% (2500) from the position
      expect(deps.aaveWithdraw).toHaveBeenCalledWith('USDC', '2500.000000');
    });

    it('should not trigger when peg and health factor are healthy', async () => {
      const deps = createMockDeps({
        getSUSDePriceOnDex: vi.fn().mockResolvedValue(1.001), // On peg
        getAaveHealthFactor: vi.fn().mockResolvedValue(3.0), // Healthy
      });
      const strategy = new YieldStrategy(deps);

      await strategy.checkCircuitBreakers();

      expect(deps.sendAlert).not.toHaveBeenCalled();
      expect(deps.sellSUSDeOnDex).not.toHaveBeenCalled();
      expect(deps.aaveWithdraw).not.toHaveBeenCalled();
    });

    it('should handle sUSDe price check failure gracefully', async () => {
      const deps = createMockDeps({
        getSUSDePriceOnDex: vi.fn().mockRejectedValue(new Error('RPC down')),
        getAaveHealthFactor: vi.fn().mockResolvedValue(3.0),
      });
      const strategy = new YieldStrategy(deps);

      // Should not throw, should continue to Aave check
      await strategy.checkCircuitBreakers();

      // Aave check still runs
      expect(deps.getAaveHealthFactor).toHaveBeenCalled();
    });
  });
});
