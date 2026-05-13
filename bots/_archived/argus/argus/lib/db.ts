/**
 * Argus Trading System — Database Setup
 *
 * SQLite with WAL mode. PRAGMA synchronous = FULL for trade_wal table.
 * All tables created on init. Concurrent writes handled via busy_timeout + BEGIN IMMEDIATE.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_CONFIG } from './config.js';

let _db: Database.Database | null = null;

/**
 * Get or create the database connection.
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = DB_CONFIG.path;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);

  // Configure for reliability
  _db.pragma('journal_mode = WAL');
  _db.pragma(`busy_timeout = ${DB_CONFIG.busyTimeout}`);
  _db.pragma('synchronous = FULL');    // Critical for trade_wal
  _db.pragma('foreign_keys = ON');

  // Run migrations
  migrate(_db);

  return _db;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Schema Migration ──────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = db.prepare(
    'SELECT MAX(version) as v FROM schema_version'
  ).get() as { v: number | null };

  const version = currentVersion?.v ?? 0;

  if (version < 1) applyV1(db);
  if (version < 2) applyV2(db);
}

function applyV1(db: Database.Database): void {
  db.exec(`
    -- Trade write-ahead log (CRITICAL: written BEFORE exchange submission)
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
    CREATE INDEX IF NOT EXISTS idx_trade_wal_strategy ON trade_wal(strategy);
    CREATE INDEX IF NOT EXISTS idx_trade_wal_created ON trade_wal(created_at);

    -- Strategy state
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      allocation_pct REAL NOT NULL,
      current_value REAL DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Active positions
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
    CREATE INDEX IF NOT EXISTS idx_positions_protocol ON positions(protocol);

    -- Funding rate history
    CREATE TABLE IF NOT EXISTS funding_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      asset TEXT NOT NULL,
      exchange TEXT NOT NULL,
      rate REAL NOT NULL,
      annualized REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_funding_rates_asset ON funding_rates(asset, timestamp);

    -- Protocol yield history
    CREATE TABLE IF NOT EXISTS yields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      protocol TEXT NOT NULL,
      asset TEXT NOT NULL,
      apy REAL NOT NULL,
      tvl REAL
    );

    CREATE INDEX IF NOT EXISTS idx_yields_protocol ON yields(protocol, timestamp);

    -- Price history
    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      asset TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prices_asset ON prices(asset, timestamp);

    -- Daily strategy performance snapshots
    CREATE TABLE IF NOT EXISTS strategy_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      strategy TEXT NOT NULL,
      daily_pnl REAL,
      total_pnl REAL,
      sharpe REAL,
      max_drawdown REAL
    );

    CREATE INDEX IF NOT EXISTS idx_performance_date ON strategy_performance(date);
    CREATE INDEX IF NOT EXISTS idx_performance_strategy ON strategy_performance(strategy, date);

    -- Circuit breaker events
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

    -- Reconciliation results
    CREATE TABLE IF NOT EXISTS reconciliation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      is_clean INTEGER NOT NULL DEFAULT 1,
      discrepancy_count INTEGER NOT NULL DEFAULT 0,
      details TEXT
    );

    -- Alert log
    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      channels TEXT NOT NULL
    );

    -- Record schema version
    INSERT INTO schema_version (version) VALUES (1);
  `);
}

function applyV2(db: Database.Database): void {
  db.exec(`
    -- Strategy metadata (key-value store for extended state)
    CREATE TABLE IF NOT EXISTS strategy_metadata (
      strategy TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (strategy, key)
    );

    INSERT INTO schema_version (version) VALUES (2);
  `);
}

// ─── Helper Functions ──────────────────────────────────────────────────────

/**
 * Begin an IMMEDIATE transaction (guarantees write lock upfront).
 * Use for all trade-related writes.
 */
export function beginImmediate(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE');
}

export function commit(db: Database.Database): void {
  db.exec('COMMIT');
}

export function rollback(db: Database.Database): void {
  db.exec('ROLLBACK');
}

/**
 * Initialize default strategy rows if they don't exist.
 */
export function initializeStrategies(db: Database.Database): void {
  const upsert = db.prepare(`
    INSERT INTO strategies (id, status, allocation_pct, current_value, total_pnl, updated_at)
    VALUES (?, ?, ?, 0, 0, datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `);

  const strategies = [
    { id: 'funding-rate', status: 'paused', allocation: 0.40 },
    { id: 'yield', status: 'paused', allocation: 0.40 },
    { id: 'reserve', status: 'active', allocation: 0.20 },
    { id: 'ondo-equities', status: 'paused', allocation: 0 },
  ];

  for (const s of strategies) {
    upsert.run(s.id, s.status, s.allocation);
  }
}

/**
 * Get trade count within a time window.
 */
export function getTradeCount(db: Database.Database, windowHours: number): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM trade_wal
    WHERE created_at > datetime('now', ? || ' hours')
    AND status IN ('submitted', 'confirmed')
  `).get(`-${windowHours}`) as { count: number };
  return result.count;
}

/**
 * Get latest price for an asset.
 */
export function getLatestPrice(db: Database.Database, asset: string): number | null {
  const result = db.prepare(`
    SELECT price FROM prices WHERE asset = ? ORDER BY timestamp DESC LIMIT 1
  `).get(asset) as { price: number } | undefined;
  return result?.price ?? null;
}

/**
 * Calculate portfolio value from all strategy current_value fields.
 */
export function getPortfolioValue(db: Database.Database): number {
  const result = db.prepare(`
    SELECT COALESCE(SUM(current_value), 0) as total FROM strategies
  `).get() as { total: number };
  return result.total;
}

/**
 * Get 24h portfolio drawdown.
 */
export function get24hDrawdown(db: Database.Database): number {
  const yesterday = db.prepare(`
    SELECT COALESCE(SUM(total_pnl), 0) as pnl FROM strategy_performance
    WHERE date = date('now', '-1 day')
  `).get() as { pnl: number };

  const today = db.prepare(`
    SELECT COALESCE(SUM(total_pnl), 0) as pnl FROM strategies
  `).get() as { pnl: number };

  const portfolioValue = getPortfolioValue(db);
  if (portfolioValue === 0) return 0;

  const drawdown = (yesterday.pnl - today.pnl) / portfolioValue;
  return Math.max(0, drawdown);
}

/**
 * Get a metadata value for a strategy.
 */
export function getMetadata(db: Database.Database, strategy: string, key: string): string | null {
  const result = db.prepare(
    'SELECT value FROM strategy_metadata WHERE strategy = ? AND key = ?'
  ).get(strategy, key) as { value: string } | undefined;
  return result?.value ?? null;
}

/**
 * Set a metadata value for a strategy (upsert).
 */
export function setMetadata(db: Database.Database, strategy: string, key: string, value: string): void {
  db.prepare(`
    INSERT INTO strategy_metadata (strategy, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(strategy, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(strategy, key, value);
}

/**
 * Clear all metadata for a strategy.
 */
export function clearMetadata(db: Database.Database, strategy: string): void {
  db.prepare('DELETE FROM strategy_metadata WHERE strategy = ?').run(strategy);
}
