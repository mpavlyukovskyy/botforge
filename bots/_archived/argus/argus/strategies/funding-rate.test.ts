/**
 * Tests for Argus Funding Rate Arbitrage Strategy.
 *
 * Uses mock deps (DI pattern) and in-memory SQLite for isolated,
 * deterministic testing of all strategy methods.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SAFETY_LIMITS } from '../lib/config.js';
import type { FundingRateStrategyDeps } from './funding-rate.js';
import type { FundingEntrySignal } from '../lib/types.js';

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

    CREATE TABLE IF NOT EXISTS funding_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      asset TEXT NOT NULL,
      exchange TEXT NOT NULL,
      rate REAL NOT NULL,
      annualized REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_funding_rates_asset ON funding_rates(asset, timestamp);

    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      asset TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_metadata (
      strategy TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (strategy, key)
    );

    CREATE TABLE IF NOT EXISTS strategy_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      strategy TEXT NOT NULL,
      daily_pnl REAL,
      total_pnl REAL,
      sharpe REAL,
      max_drawdown REAL
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

  // Insert default funding-rate strategy
  db.prepare(`
    INSERT INTO strategies (id, status, allocation_pct, current_value, total_pnl, updated_at)
    VALUES ('funding-rate', 'active', 0.40, 100000, 0, datetime('now'))
  `).run();

  // Reserve strategy for cash reserve checks
  db.prepare(`
    INSERT INTO strategies (id, status, allocation_pct, current_value, total_pnl, updated_at)
    VALUES ('reserve', 'active', 0.20, 50000, 0, datetime('now'))
  `).run();

  return db;
}

// ─── Mock Deps ────────────────────────────────────────────────────────────────

function createMockDeps(overrides?: Partial<FundingRateStrategyDeps>): FundingRateStrategyDeps {
  return {
    buySpot: vi.fn().mockResolvedValue({ success: true, txHash: '0xspot', fillPrice: 2500 }),
    sellSpot: vi.fn().mockResolvedValue({ success: true, txHash: '0xsell', fillPrice: 2500 }),
    openShort: vi.fn().mockResolvedValue({ success: true, orderId: 'ord1', fillPrice: 2500 }),
    closeShort: vi.fn().mockResolvedValue({ success: true, orderId: 'ord2', fillPrice: 2500 }),
    getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
    getSpotPrice: vi.fn().mockResolvedValue(2500),
    getPerpPrice: vi.fn().mockResolvedValue(2500),
    getMarginRatio: vi.fn().mockResolvedValue(0.60),
    getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
    getOpenInterest: vi.fn().mockResolvedValue(100_000_000),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    adjustPerp: vi.fn().mockResolvedValue({ success: true }),
    sendAlert: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Seed Helpers ─────────────────────────────────────────────────────────────

function seedElevatedFundingRates(db: Database.Database, asset: string, hours: number, annualized: number) {
  // Insert funding rates every 5 minutes going back `hours` hours
  const now = Date.now();
  for (let i = 0; i < hours * 12; i++) {
    const ts = new Date(now - i * 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      "INSERT INTO funding_rates (timestamp, asset, exchange, rate, annualized) VALUES (?, ?, 'hyperliquid', ?, ?)"
    ).run(ts, asset, annualized / (365 * 3), annualized);
  }
}

function seedPositions(db: Database.Database, asset: string, spotSize: number, perpSize: number, entryPrice: number) {
  db.prepare(`
    INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, opened_at, updated_at)
    VALUES ('funding-rate', ?, 'wallet', 'long', ?, ?, datetime('now'), datetime('now'))
  `).run(asset, spotSize, entryPrice);

  db.prepare(`
    INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, opened_at, updated_at)
    VALUES ('funding-rate', ?, 'hyperliquid', 'short', ?, ?, datetime('now'), datetime('now'))
  `).run(asset, perpSize, entryPrice);
}

function seedMetadata(db: Database.Database) {
  const meta: Array<[string, string]> = [
    ['entryFundingRate', '0.15'],
    ['collectedFunding', '50'],
    ['lastFundingCheckTimestamp', new Date(Date.now() - 3600000).toISOString()],
    ['entrySpotPrice', '2400'],
    ['entryPerpPrice', '2400'],
  ];
  for (const [key, value] of meta) {
    db.prepare(`
      INSERT INTO strategy_metadata (strategy, key, value, updated_at)
      VALUES ('funding-rate', ?, ?, datetime('now'))
    `).run(key, value);
  }
}

// ─── Module Mocking ───────────────────────────────────────────────────────────

// We need to mock getDb(), the WAL functions, and risk functions
// so they use our in-memory test DB instead of the file-system one.

let testDb: Database.Database;

vi.mock('../lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/db.js')>('../lib/db.js');
  return {
    ...actual,
    getDb: () => testDb,
    getMetadata: (db: Database.Database, strategy: string, key: string) => {
      const result = testDb.prepare(
        'SELECT value FROM strategy_metadata WHERE strategy = ? AND key = ?'
      ).get(strategy, key) as { value: string } | undefined;
      return result?.value ?? null;
    },
    setMetadata: (db: Database.Database, strategy: string, key: string, value: string) => {
      testDb.prepare(`
        INSERT INTO strategy_metadata (strategy, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(strategy, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(strategy, key, value);
    },
    clearMetadata: (db: Database.Database, strategy: string) => {
      testDb.prepare('DELETE FROM strategy_metadata WHERE strategy = ?').run(strategy);
    },
    getPortfolioValue: () => {
      const result = testDb.prepare('SELECT COALESCE(SUM(current_value), 0) as total FROM strategies').get() as { total: number };
      return result.total;
    },
    get24hDrawdown: () => 0,
    getTradeCount: () => 0,
    beginImmediate: () => testDb.exec('BEGIN IMMEDIATE'),
    commit: () => testDb.exec('COMMIT'),
    rollback: () => testDb.exec('ROLLBACK'),
  };
});

vi.mock('../safety/trade-wal.js', () => {
  let walCounter = 0;
  return {
    recordTradeIntent: vi.fn(() => {
      walCounter++;
      const stmt = testDb.prepare(`
        INSERT INTO trade_wal (strategy, asset, protocol, direction, size, intent_price, status, created_at)
        VALUES ('funding-rate', 'ETH', 'wallet', 'buy', '1', '2500', 'pending', datetime('now'))
      `);
      const result = stmt.run();
      return Number(result.lastInsertRowid);
    }),
    markConfirmed: vi.fn((walId: number, params: { txHash: string; fillPrice: string; fillSize: string }) => {
      testDb.prepare(`
        UPDATE trade_wal SET status = 'confirmed', tx_hash = ?, fill_price = ?, fill_size = ?, confirmed_at = datetime('now') WHERE id = ?
      `).run(params.txHash, params.fillPrice, params.fillSize, walId);
    }),
    markFailed: vi.fn((walId: number, error: string) => {
      testDb.prepare("UPDATE trade_wal SET status = 'failed', error = ? WHERE id = ?").run(error, walId);
    }),
  };
});

vi.mock('../execution/risk.js', () => ({
  validateTrade: vi.fn().mockReturnValue({ allowed: true }),
  checkCircuitBreakers: vi.fn().mockReturnValue({ allowed: true }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

// Import after mocks are set up
const { FundingRateStrategy } = await import('./funding-rate.js');
const { recordTradeIntent, markConfirmed, markFailed } = await import('../safety/trade-wal.js');
const { validateTrade, checkCircuitBreakers: checkCB } = await import('../execution/risk.js');

describe('FundingRateStrategy', () => {
  beforeEach(() => {
    testDb = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  // ── evaluate() ──────────────────────────────────────────────────────────

  describe('evaluate()', () => {
    it('no signal when funding rate too low', async () => {
      const deps = createMockDeps({
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.0003, annualized: 0.05 }),
      });
      const strategy = new FundingRateStrategy(deps);

      await strategy.evaluate();

      expect(deps.buySpot).not.toHaveBeenCalled();
      expect(deps.openShort).not.toHaveBeenCalled();
      expect(strategy.getState()).toBeNull();
    });

    it('entry signal when all conditions met', async () => {
      seedElevatedFundingRates(testDb, 'ETH', 25, 0.15);

      const deps = createMockDeps({
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getOpenInterest: vi.fn().mockResolvedValue(100_000_000),
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2500),
      });
      const strategy = new FundingRateStrategy(deps);

      await strategy.evaluate();

      expect(deps.buySpot).toHaveBeenCalled();
      expect(deps.openShort).toHaveBeenCalled();
      expect(strategy.getState()?.isActive).toBe(true);
      expect(strategy.getState()?.spotAsset).toBe('ETH');
    });

    it('exit signal on low rate', async () => {
      // Set up active position
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      // Seed low rates in last 16h
      const now = Date.now();
      for (let i = 0; i < 40; i++) {
        const ts = new Date(now - i * 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        testDb.prepare(
          "INSERT INTO funding_rates (timestamp, asset, exchange, rate, annualized) VALUES (?, 'ETH', 'hyperliquid', 0.0001, 0.03)"
        ).run(ts);
      }

      const deps = createMockDeps({
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.0001, annualized: 0.03 }),
      });
      const strategy = new FundingRateStrategy(deps);

      await strategy.evaluate();

      // Should have exited — sellSpot and closeShort called
      expect(deps.sellSpot).toHaveBeenCalled();
      expect(deps.closeShort).toHaveBeenCalled();
    });

    it('exit signal on negative funding', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      // Seed all negative rates in last 16h
      const now = Date.now();
      for (let i = 0; i < 40; i++) {
        const ts = new Date(now - i * 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        testDb.prepare(
          "INSERT INTO funding_rates (timestamp, asset, exchange, rate, annualized) VALUES (?, 'ETH', 'hyperliquid', -0.001, -0.10)"
        ).run(ts);
      }

      const deps = createMockDeps({
        getFundingRate: vi.fn().mockResolvedValue({ rate: -0.001, annualized: -0.10 }),
      });
      const strategy = new FundingRateStrategy(deps);

      await strategy.evaluate();

      expect(deps.sellSpot).toHaveBeenCalled();
      expect(deps.closeShort).toHaveBeenCalled();
    });

    it('mutex prevents concurrent execution', async () => {
      const deps = createMockDeps({
        getFundingRate: vi.fn().mockImplementation(() => new Promise(resolve => {
          setTimeout(() => resolve({ rate: 0.001, annualized: 0.05 }), 50);
        })),
      });
      const strategy = new FundingRateStrategy(deps);

      // Launch two evaluations simultaneously
      const [r1, r2] = await Promise.allSettled([
        strategy.evaluate(),
        strategy.evaluate(),
      ]);

      // getFundingRate is called once per asset per evaluate, but only one evaluate
      // should run (the other should be blocked by mutex)
      // With 3 assets and 1 evaluate running, we expect 3 calls max
      expect((deps.getFundingRate as any).mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('is no-op when strategy is paused', async () => {
      testDb.prepare("UPDATE strategies SET status = 'paused' WHERE id = 'funding-rate'").run();

      const deps = createMockDeps();
      const strategy = new FundingRateStrategy(deps);

      await strategy.evaluate();

      expect(deps.getFundingRate).not.toHaveBeenCalled();
    });
  });

  // ── enter() ─────────────────────────────────────────────────────────────

  describe('enter()', () => {
    const signal: FundingEntrySignal = {
      type: 'enter',
      asset: 'ETH',
      fundingRate8h: 0.001,
      annualizedRate: 0.15,
      openInterest: 100_000_000,
      spotPrice: 2500,
      perpPrice: 2500,
      recommendedSize: 20,
    };

    it('both legs succeed — state set correctly', async () => {
      const deps = createMockDeps();
      const strategy = new FundingRateStrategy(deps);

      await strategy.enter('ETH', signal);

      expect(strategy.getState()?.isActive).toBe(true);
      expect(strategy.getState()?.spotAsset).toBe('ETH');
      expect(strategy.getState()?.spotSize).toBe(20);
      expect(strategy.getState()?.perpSize).toBe(20);

      // Check positions inserted
      const positions = testDb.prepare(
        "SELECT * FROM positions WHERE strategy = 'funding-rate'"
      ).all() as any[];
      expect(positions.length).toBe(2);

      // Check WAL entries confirmed
      expect(recordTradeIntent).toHaveBeenCalledTimes(2);
      expect(markConfirmed).toHaveBeenCalledTimes(2);
    });

    it('spot succeeds perp fails — unwind and halt', async () => {
      const deps = createMockDeps({
        openShort: vi.fn().mockResolvedValue({ success: false, error: 'Insufficient margin' }),
      });
      const strategy = new FundingRateStrategy(deps);

      await strategy.enter('ETH', signal);

      expect(strategy.getState()).toBeNull();
      expect(deps.sellSpot).toHaveBeenCalledWith('ETH', 20); // Unwind
      expect(deps.sendAlert).toHaveBeenCalledWith(
        'emergency',
        expect.stringContaining('UNHEDGED'),
        expect.any(String),
      );

      // Strategy should be halted
      const s = testDb.prepare("SELECT status FROM strategies WHERE id = 'funding-rate'").get() as any;
      expect(s.status).toBe('halted');
    });

    it('both legs fail — no halt, warning only', async () => {
      const deps = createMockDeps({
        buySpot: vi.fn().mockResolvedValue({ success: false, error: 'No liquidity' }),
        openShort: vi.fn().mockResolvedValue({ success: false, error: 'Insufficient margin' }),
      });
      const strategy = new FundingRateStrategy(deps);

      await strategy.enter('ETH', signal);

      expect(strategy.getState()).toBeNull();
      expect(deps.sendAlert).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('Entry Failed'),
        expect.any(String),
      );

      // Strategy should NOT be halted
      const s = testDb.prepare("SELECT status FROM strategies WHERE id = 'funding-rate'").get() as any;
      expect(s.status).toBe('active');
    });

    it('does not enter if already in position', async () => {
      const deps = createMockDeps();
      const strategy = new FundingRateStrategy(deps);

      await strategy.enter('ETH', signal); // First enter
      vi.clearAllMocks();
      await strategy.enter('ETH', signal); // Second enter — should skip

      expect(deps.buySpot).not.toHaveBeenCalled();
    });
  });

  // ── exit() ──────────────────────────────────────────────────────────────

  describe('exit()', () => {
    it('both legs succeed — PnL correct', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const deps = createMockDeps({
        getSpotPrice: vi.fn().mockResolvedValue(2600),
        getPerpPrice: vi.fn().mockResolvedValue(2600),
        sellSpot: vi.fn().mockResolvedValue({ success: true, txHash: '0xsell', fillPrice: 2600 }),
        closeShort: vi.fn().mockResolvedValue({ success: true, orderId: 'close1', fillPrice: 2600 }),
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getMarginRatio: vi.fn().mockResolvedValue(0.60),
        getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
      });
      const strategy = new FundingRateStrategy(deps);

      // Load state first
      await strategy.loadState();
      expect(strategy.getState()?.isActive).toBe(true);

      await strategy.exit('low_rate');

      expect(strategy.getState()).toBeNull();

      // Positions deleted
      const positions = testDb.prepare(
        "SELECT * FROM positions WHERE strategy = 'funding-rate'"
      ).all();
      expect(positions.length).toBe(0);

      // PnL updated:
      // spotPnl = (2600 - 2400) * 20 = 4000
      // perpPnl = (2400 - 2600) * 20 = -4000
      // fundingPnl = 50
      // total = 50
      const s = testDb.prepare("SELECT total_pnl FROM strategies WHERE id = 'funding-rate'").get() as any;
      expect(s.total_pnl).toBeCloseTo(50, 0);

      // Metadata cleared
      const meta = testDb.prepare(
        "SELECT * FROM strategy_metadata WHERE strategy = 'funding-rate'"
      ).all();
      expect(meta.length).toBe(0);
    });

    it('one leg fails — halt and UNHEDGED alert', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const deps = createMockDeps({
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2500),
        sellSpot: vi.fn().mockResolvedValue({ success: true, txHash: '0xsell', fillPrice: 2500 }),
        closeShort: vi.fn().mockResolvedValue({ success: false, error: 'Exchange down' }),
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getMarginRatio: vi.fn().mockResolvedValue(0.60),
        getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
      });
      const strategy = new FundingRateStrategy(deps);
      await strategy.loadState();

      await strategy.exit('basis_divergence');

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'emergency',
        expect.stringContaining('UNHEDGED'),
        expect.any(String),
      );

      const s = testDb.prepare("SELECT status FROM strategies WHERE id = 'funding-rate'").get() as any;
      expect(s.status).toBe('halted');
    });
  });

  // ── rebalance() ─────────────────────────────────────────────────────────

  describe('rebalance()', () => {
    it('leverage too high — adjustPerp called with negative delta', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const deps = createMockDeps({
        getCurrentLeverage: vi.fn().mockResolvedValue(2.8),
        getPerpPrice: vi.fn().mockResolvedValue(2500),
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getMarginRatio: vi.fn().mockResolvedValue(0.60),
      });
      const strategy = new FundingRateStrategy(deps);
      await strategy.loadState();

      await strategy.rebalance();

      expect(deps.adjustPerp).toHaveBeenCalled();
      // With leverage 2.8 and target 2.0, delta should be negative (reduce short)
      const call = (deps.adjustPerp as any).mock.calls[0];
      expect(call[0]).toBe('ETH');
      expect(call[1]).toBeLessThan(0); // Reducing position
    });

    it('within bounds — no action', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const deps = createMockDeps({
        getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2500),
        getMarginRatio: vi.fn().mockResolvedValue(0.60),
      });
      const strategy = new FundingRateStrategy(deps);
      await strategy.loadState();

      await strategy.rebalance();

      expect(deps.adjustPerp).not.toHaveBeenCalled();
    });
  });

  // ── collectFunding() ────────────────────────────────────────────────────

  describe('collectFunding()', () => {
    it('new payments summed correctly', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const now = new Date();
      const deps = createMockDeps({
        getFundingHistory: vi.fn().mockResolvedValue([
          { timestamp: now.toISOString(), amount: 10.5, rate: 0.001 },
          { timestamp: now.toISOString(), amount: 5.25, rate: 0.0005 },
        ]),
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2500),
        getMarginRatio: vi.fn().mockResolvedValue(0.60),
        getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
      });
      const strategy = new FundingRateStrategy(deps);
      await strategy.loadState();

      await strategy.collectFunding();

      // Initial collected = 50, new = 10.5 + 5.25 = 15.75
      expect(strategy.getState()?.collectedFunding).toBeCloseTo(65.75, 1);
    });

    it('no double counting (watermark updated)', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      // Payment timestamp is in the past (before watermark will be set)
      const pastTimestamp = new Date(Date.now() - 60000).toISOString();
      const payment = { timestamp: pastTimestamp, amount: 10, rate: 0.001 };

      let callCount = 0;
      const deps = createMockDeps({
        getFundingHistory: vi.fn().mockImplementation(() => {
          callCount++;
          // Always return the same old payment
          return Promise.resolve([payment]);
        }),
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2500),
        getMarginRatio: vi.fn().mockResolvedValue(0.60),
        getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
      });
      const strategy = new FundingRateStrategy(deps);
      await strategy.loadState();

      await strategy.collectFunding();
      const afterFirst = strategy.getState()?.collectedFunding ?? 0;

      // Second call — the watermark was updated to "now" after first call,
      // so the old payment (pastTimestamp) is filtered out
      await strategy.collectFunding();
      const afterSecond = strategy.getState()?.collectedFunding ?? 0;

      // Should be same since second call filters out old payments
      expect(afterSecond).toBeCloseTo(afterFirst, 1);
    });
  });

  // ── loadState() ─────────────────────────────────────────────────────────

  describe('loadState()', () => {
    it('reconstructs from DB positions + metadata', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const deps = createMockDeps({
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.12 }),
        getMarginRatio: vi.fn().mockResolvedValue(0.55),
        getCurrentLeverage: vi.fn().mockResolvedValue(1.9),
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2502),
      });
      const strategy = new FundingRateStrategy(deps);

      await strategy.loadState();

      const state = strategy.getState();
      expect(state).not.toBeNull();
      expect(state!.isActive).toBe(true);
      expect(state!.spotAsset).toBe('ETH');
      expect(state!.spotSize).toBe(20);
      expect(state!.perpSize).toBe(20);
      expect(state!.entryFundingRate).toBeCloseTo(0.15);
      expect(state!.collectedFunding).toBeCloseTo(50);
      expect(state!.currentFundingRate).toBeCloseTo(0.12);
    });

    it('detects orphaned single leg and halts', async () => {
      // Insert only long position (no short)
      testDb.prepare(`
        INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, opened_at, updated_at)
        VALUES ('funding-rate', 'ETH', 'wallet', 'long', 20, 2400, datetime('now'), datetime('now'))
      `).run();

      const deps = createMockDeps();
      const strategy = new FundingRateStrategy(deps);

      await strategy.loadState();

      expect(strategy.getState()).toBeNull();
      expect(deps.sendAlert).toHaveBeenCalledWith(
        'emergency',
        expect.stringContaining('UNHEDGED'),
        expect.any(String),
      );

      const s = testDb.prepare("SELECT status FROM strategies WHERE id = 'funding-rate'").get() as any;
      expect(s.status).toBe('halted');
    });

    it('no positions — clean null state', async () => {
      const deps = createMockDeps();
      const strategy = new FundingRateStrategy(deps);

      await strategy.loadState();

      expect(strategy.getState()).toBeNull();
      expect(deps.sendAlert).not.toHaveBeenCalled();
    });
  });

  // ── checkCircuitBreakers() ──────────────────────────────────────────────

  describe('checkCircuitBreakers()', () => {
    it('basis divergence triggers exit + halt', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const deps = createMockDeps({
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2560), // 2.4% divergence > 2% threshold
        getMarginRatio: vi.fn().mockResolvedValue(0.60),
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
      });
      const strategy = new FundingRateStrategy(deps);
      await strategy.loadState();

      await strategy.checkCircuitBreakers();

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'critical',
        expect.stringContaining('Basis Divergence'),
        expect.any(String),
      );
      // Exit should have been called (sellSpot + closeShort)
      expect(deps.sellSpot).toHaveBeenCalled();

      const s = testDb.prepare("SELECT status FROM strategies WHERE id = 'funding-rate'").get() as any;
      expect(s.status).toBe('halted');
    });

    it('margin ratio below threshold triggers exit + halt', async () => {
      seedPositions(testDb, 'ETH', 20, 20, 2400);
      seedMetadata(testDb);

      const deps = createMockDeps({
        getSpotPrice: vi.fn().mockResolvedValue(2500),
        getPerpPrice: vi.fn().mockResolvedValue(2500), // No basis divergence
        getMarginRatio: vi.fn().mockResolvedValue(0.30), // Below 40% threshold
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.001, annualized: 0.15 }),
        getCurrentLeverage: vi.fn().mockResolvedValue(2.0),
      });
      const strategy = new FundingRateStrategy(deps);
      await strategy.loadState();

      await strategy.checkCircuitBreakers();

      expect(deps.sendAlert).toHaveBeenCalledWith(
        'critical',
        expect.stringContaining('Margin Ratio'),
        expect.any(String),
      );
      expect(deps.sellSpot).toHaveBeenCalled();
    });
  });
});
