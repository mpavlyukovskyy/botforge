/**
 * Seed Argus with $100 paper portfolio.
 *
 * Idempotent — safe to re-run. Wraps all writes in a transaction.
 *
 * Allocation:
 *   funding-rate  40%  →  $40 ready capital (no positions — strategy creates arb legs on entry)
 *   yield         40%  →  $16 Aave USDC, $14 sUSDe, $10 USDY
 *   reserve       20%  →  $20 USDC in wallet
 *
 * Run: node --import tsx bots/argus/scripts/seed-paper-portfolio.ts
 */

import { getDb, initializeStrategies, clearMetadata } from '../lib/db.js';

const TOTAL_CAPITAL = 100;

function seed(): void {
  const db = getDb();

  // Ensure strategy rows exist
  initializeStrategies(db);

  const tx = db.transaction(() => {
    // ── 1. Activate strategies with correct values ──────────────────────

    db.prepare(`
      UPDATE strategies
      SET status = 'active', current_value = ?, total_pnl = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(40, 'funding-rate');

    db.prepare(`
      UPDATE strategies
      SET status = 'active', current_value = ?, total_pnl = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(40, 'yield');

    db.prepare(`
      UPDATE strategies
      SET status = 'active', current_value = ?, total_pnl = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(20, 'reserve');

    // ondo-equities stays paused at $0
    db.prepare(`
      UPDATE strategies
      SET status = 'paused', current_value = 0, total_pnl = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run('ondo-equities');

    // ── 2. Clean slate for positions ────────────────────────────────────

    db.prepare('DELETE FROM positions').run();

    // ── 3. Clear stale funding-rate metadata ────────────────────────────

    clearMetadata(db, 'funding-rate');

    // ── 4. Insert positions ─────────────────────────────────────────────

    const insertPos = db.prepare(`
      INSERT INTO positions (strategy, asset, protocol, side, size, entry_price, current_price, unrealized_pnl, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    // funding-rate: NO positions — $40 is ready capital tracked via strategy current_value.
    // The strategy's loadState() interprets a lone 'long' without matching 'short' as
    // an orphaned arb leg and halts. Positions are only created when the strategy enters.

    // yield: $16 Aave USDC supply
    insertPos.run('yield', 'USDC', 'aave-v3', 'supply', 16, 1.0, 1.0, 0);

    // yield: $14 sUSDe stake
    insertPos.run('yield', 'sUSDe', 'ethena', 'stake', 14, 1.0, 1.0, 0);

    // yield: $10 USDY
    insertPos.run('yield', 'USDY', 'ondo', 'long', 10, 1.0, 1.0, 0);

    // reserve: $20 USDC in wallet
    insertPos.run('reserve', 'USDC', 'wallet', 'long', 20, 1.0, 1.0, 0);
  });

  tx();

  // ── Verify ──────────────────────────────────────────────────────────────

  const total = db.prepare(
    'SELECT COALESCE(SUM(current_value), 0) as v FROM strategies'
  ).get() as { v: number };

  const posCount = db.prepare(
    'SELECT COUNT(*) as c FROM positions'
  ).get() as { c: number };

  const strategies = db.prepare(
    'SELECT id, status, current_value FROM strategies ORDER BY allocation_pct DESC'
  ).all() as Array<{ id: string; status: string; current_value: number }>;

  console.log('Argus paper portfolio seeded:');
  console.log(`  Total: $${total.v}`);
  console.log(`  Positions: ${posCount.c}`);
  for (const s of strategies) {
    console.log(`  ${s.id}: $${s.current_value} (${s.status})`);
  }

  db.close();
}

seed();
