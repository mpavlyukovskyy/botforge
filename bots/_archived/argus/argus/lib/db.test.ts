/**
 * Tests for Argus database module.
 * Uses in-memory SQLite for fast, isolated tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// We test the DB helpers directly against an in-memory database
// rather than using getDb() which relies on file-system state.

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  // Apply V1 schema
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

    CREATE TABLE IF NOT EXISTS funding_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      asset TEXT NOT NULL,
      exchange TEXT NOT NULL,
      rate REAL NOT NULL,
      annualized REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS yields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      protocol TEXT NOT NULL,
      asset TEXT NOT NULL,
      apy REAL NOT NULL,
      tvl REAL
    );

    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      asset TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS circuit_breaker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL,
      strategy TEXT NOT NULL,
      trigger_name TEXT NOT NULL,
      value REAL NOT NULL,
      threshold REAL NOT NULL,
      action TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reconciliation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      is_clean INTEGER NOT NULL DEFAULT 1,
      discrepancy_count INTEGER NOT NULL DEFAULT 0,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      channels TEXT NOT NULL
    );

    INSERT INTO schema_version (version) VALUES (1);
  `);

  return db;
}

describe('Database schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates all expected tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('trade_wal');
    expect(tableNames).toContain('strategies');
    expect(tableNames).toContain('positions');
    expect(tableNames).toContain('funding_rates');
    expect(tableNames).toContain('yields');
    expect(tableNames).toContain('prices');
    expect(tableNames).toContain('strategy_performance');
    expect(tableNames).toContain('circuit_breaker_events');
    expect(tableNames).toContain('reconciliation_log');
    expect(tableNames).toContain('alert_log');
  });

  it('schema version is 1', () => {
    const result = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(result.v).toBe(1);
  });
});

describe('Strategy CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and queries strategies', () => {
    db.prepare(
      "INSERT INTO strategies (id, status, allocation_pct, current_value, total_pnl, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('funding-rate', 'active', 0.40, 40000, 500);

    const s = db.prepare('SELECT * FROM strategies WHERE id = ?').get('funding-rate') as any;
    expect(s.id).toBe('funding-rate');
    expect(s.status).toBe('active');
    expect(s.allocation_pct).toBeCloseTo(0.40);
    expect(s.current_value).toBe(40000);
    expect(s.total_pnl).toBe(500);
  });

  it('ON CONFLICT DO NOTHING preserves existing rows', () => {
    db.prepare(
      "INSERT INTO strategies (id, status, allocation_pct, updated_at) VALUES (?, ?, ?, datetime('now'))"
    ).run('yield', 'active', 0.40);

    // Try to insert again with different values
    db.prepare(
      "INSERT INTO strategies (id, status, allocation_pct, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(id) DO NOTHING"
    ).run('yield', 'paused', 0.50);

    const s = db.prepare('SELECT * FROM strategies WHERE id = ?').get('yield') as any;
    expect(s.status).toBe('active');
    expect(s.allocation_pct).toBeCloseTo(0.40);
  });
});

describe('Trade WAL', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts trade with pending status', () => {
    const result = db.prepare(`
      INSERT INTO trade_wal (strategy, asset, protocol, direction, size, intent_price, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run('funding-rate', 'ETH', 'hyperliquid', 'short', '1.5', '2500');

    expect(result.lastInsertRowid).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM trade_wal WHERE id = ?').get(result.lastInsertRowid) as any;
    expect(row.status).toBe('pending');
    expect(row.strategy).toBe('funding-rate');
    expect(row.asset).toBe('ETH');
  });

  it('transitions pending → submitted → confirmed', () => {
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO trade_wal (strategy, asset, protocol, direction, size, intent_price)
      VALUES ('funding-rate', 'ETH', 'hyperliquid', 'short', '1', '2500')
    `).run();

    // Submit
    db.prepare("UPDATE trade_wal SET status = 'submitted', tx_hash = ? WHERE id = ?")
      .run('0xabc123', id);

    let row = db.prepare('SELECT status FROM trade_wal WHERE id = ?').get(id) as any;
    expect(row.status).toBe('submitted');

    // Confirm
    db.prepare(`
      UPDATE trade_wal SET status = 'confirmed', fill_price = ?, fill_size = ?, confirmed_at = datetime('now') WHERE id = ?
    `).run('2498', '1', id);

    row = db.prepare('SELECT status, fill_price FROM trade_wal WHERE id = ?').get(id) as any;
    expect(row.status).toBe('confirmed');
    expect(row.fill_price).toBe('2498');
  });

  it('transitions pending → failed', () => {
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO trade_wal (strategy, asset, protocol, direction, size, intent_price)
      VALUES ('funding-rate', 'ETH', 'hyperliquid', 'short', '1', '2500')
    `).run();

    db.prepare("UPDATE trade_wal SET status = 'failed', error = ? WHERE id = ?")
      .run('Insufficient margin', id);

    const row = db.prepare('SELECT status, error FROM trade_wal WHERE id = ?').get(id) as any;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Insufficient margin');
  });
});

describe('Price queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns latest price for an asset', () => {
    db.prepare(
      "INSERT INTO prices (timestamp, asset, price, source) VALUES (datetime('now', '-1 hour'), ?, ?, ?)"
    ).run('ETH', 2400, 'hyperliquid');

    db.prepare(
      "INSERT INTO prices (timestamp, asset, price, source) VALUES (datetime('now'), ?, ?, ?)"
    ).run('ETH', 2500, 'hyperliquid');

    const result = db.prepare(
      'SELECT price FROM prices WHERE asset = ? ORDER BY timestamp DESC LIMIT 1'
    ).get('ETH') as { price: number };

    expect(result.price).toBe(2500);
  });

  it('returns null for missing asset', () => {
    const result = db.prepare(
      'SELECT price FROM prices WHERE asset = ? ORDER BY timestamp DESC LIMIT 1'
    ).get('NONEXISTENT') as { price: number } | undefined;

    expect(result).toBeUndefined();
  });
});

describe('Portfolio value', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('sums all strategy current_value fields', () => {
    db.prepare("INSERT INTO strategies (id, status, allocation_pct, current_value, updated_at) VALUES (?, 'active', 0.40, ?, datetime('now'))").run('funding-rate', 40000);
    db.prepare("INSERT INTO strategies (id, status, allocation_pct, current_value, updated_at) VALUES (?, 'active', 0.40, ?, datetime('now'))").run('yield', 35000);
    db.prepare("INSERT INTO strategies (id, status, allocation_pct, current_value, updated_at) VALUES (?, 'active', 0.20, ?, datetime('now'))").run('reserve', 20000);

    const result = db.prepare('SELECT COALESCE(SUM(current_value), 0) as total FROM strategies').get() as { total: number };
    expect(result.total).toBe(95000);
  });

  it('returns 0 when no strategies exist', () => {
    const result = db.prepare('SELECT COALESCE(SUM(current_value), 0) as total FROM strategies').get() as { total: number };
    expect(result.total).toBe(0);
  });
});

describe('BEGIN IMMEDIATE transactions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('commits successfully', () => {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO strategies (id, status, allocation_pct, updated_at) VALUES (?, 'active', 0.40, datetime('now'))").run('test');
    db.exec('COMMIT');

    const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get('test') as any;
    expect(row).toBeDefined();
    expect(row.id).toBe('test');
  });

  it('rollback undoes changes', () => {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO strategies (id, status, allocation_pct, updated_at) VALUES (?, 'active', 0.40, datetime('now'))").run('should-not-exist');
    db.exec('ROLLBACK');

    const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get('should-not-exist');
    expect(row).toBeUndefined();
  });
});
