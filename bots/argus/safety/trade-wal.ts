/**
 * Argus Trading System — Trade Write-Ahead Log
 *
 * ALL trades must be recorded BEFORE exchange submission.
 * Flow: write pending → submit to exchange → update to confirmed/failed
 *
 * On startup: scan for 'pending' or 'submitted' rows → reconcile.
 */

import type Database from 'better-sqlite3';
import type { StrategyId, Protocol, TradeDirection, TradeStatus, TradeWalEntry } from '../lib/types.js';
import { getDb, beginImmediate, commit, rollback } from '../lib/db.js';

/**
 * Record trade intent BEFORE submitting to exchange.
 * Uses BEGIN IMMEDIATE for guaranteed write lock.
 */
export function recordTradeIntent(params: {
  strategy: StrategyId;
  asset: string;
  protocol: Protocol;
  direction: TradeDirection;
  size: string;
  intentPrice: string;
}): number {
  const db = getDb();

  beginImmediate(db);
  try {
    const stmt = db.prepare(`
      INSERT INTO trade_wal (strategy, asset, protocol, direction, size, intent_price, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `);

    const result = stmt.run(
      params.strategy,
      params.asset,
      params.protocol,
      params.direction,
      params.size,
      params.intentPrice,
    );

    commit(db);
    return Number(result.lastInsertRowid);
  } catch (err) {
    rollback(db);
    throw err;
  }
}

/**
 * Mark trade as submitted (exchange has received the order).
 */
export function markSubmitted(walId: number, txHash?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE trade_wal SET status = 'submitted', tx_hash = ? WHERE id = ?
  `).run(txHash || null, walId);
}

/**
 * Mark trade as confirmed (fill received).
 */
export function markConfirmed(walId: number, params: {
  txHash: string;
  fillPrice: string;
  fillSize: string;
}): void {
  const db = getDb();
  db.prepare(`
    UPDATE trade_wal
    SET status = 'confirmed',
        tx_hash = ?,
        fill_price = ?,
        fill_size = ?,
        confirmed_at = datetime('now')
    WHERE id = ?
  `).run(params.txHash, params.fillPrice, params.fillSize, walId);
}

/**
 * Mark trade as failed.
 */
export function markFailed(walId: number, error: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE trade_wal SET status = 'failed', error = ? WHERE id = ?
  `).run(error, walId);
}

/**
 * Get all pending or submitted trades (for startup reconciliation).
 */
export function getIncompleteTradeEntries(): TradeWalEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM trade_wal WHERE status IN ('pending', 'submitted')
    ORDER BY created_at ASC
  `).all() as TradeWalEntry[];
}

/**
 * Get recent trades for display.
 */
export function getRecentTrades(limit: number = 20): TradeWalEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM trade_wal ORDER BY created_at DESC LIMIT ?
  `).all(limit) as TradeWalEntry[];
}

/**
 * Get trades for a specific strategy.
 */
export function getTradesByStrategy(strategy: StrategyId, limit: number = 50): TradeWalEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM trade_wal WHERE strategy = ? ORDER BY created_at DESC LIMIT ?
  `).all(strategy, limit) as TradeWalEntry[];
}

/**
 * Count trades in last N hours (for rate limiting).
 */
export function countRecentTrades(hours: number): number {
  const db = getDb();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM trade_wal
    WHERE created_at > datetime('now', '-' || ? || ' hours')
    AND status IN ('submitted', 'confirmed')
  `).get(hours) as { count: number };
  return result.count;
}

/**
 * Execute a trade with WAL protection.
 *
 * This is the canonical way to submit a trade:
 * 1. Record intent in WAL
 * 2. Execute the trade function
 * 3. Update WAL with result
 *
 * If the process crashes between steps 1-3, the reconciliation
 * engine will detect the incomplete trade on restart.
 */
export async function executeWithWal<T extends { success: boolean; txHash?: string; fillPrice?: number; fillSize?: number; error?: string }>(
  params: {
    strategy: StrategyId;
    asset: string;
    protocol: Protocol;
    direction: TradeDirection;
    size: string;
    intentPrice: string;
  },
  executeFn: () => Promise<T>,
): Promise<{ walId: number; result: T }> {
  // Step 1: Record intent
  const walId = recordTradeIntent(params);

  // Step 2: Execute
  let result: T;
  try {
    markSubmitted(walId);
    result = await executeFn();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    markFailed(walId, errorMsg);
    throw err;
  }

  // Step 3: Update with result
  if (result.success) {
    markConfirmed(walId, {
      txHash: result.txHash || '',
      fillPrice: String(result.fillPrice ?? params.intentPrice),
      fillSize: String(result.fillSize ?? params.size),
    });
  } else {
    markFailed(walId, result.error || 'Unknown error');
  }

  return { walId, result };
}
