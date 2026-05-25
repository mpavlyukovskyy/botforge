/**
 * Test for get_balance tool — confirms the end-to-end financial aggregation
 * over a freshly seeded DB. Validates that earnings + overdue debt +
 * deductions all flow into the right line items.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import getBalance from './get_balance.js';
import { runMigrations, getCurrentBillingMonth } from '../lib/db.js';
import { ensureDb, __resetDbForTests } from '../lib/atlas-client.js';

let workdir;

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeCtx() {
  return {
    config: { name: `KristinaTest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    log: noopLog,
    chatId: '381823289',
    userId: '381823289',
    userName: 'Mark',
  };
}

beforeEach(() => {
  __resetDbForTests();
  workdir = mkdtempSync(join(tmpdir(), 'kristina-balance-test-'));
  process.chdir(workdir);
});

afterEach(() => {
  __resetDbForTests();
  rmSync(workdir, { recursive: true, force: true });
});

describe('get_balance tool', () => {
  it('returns zeroes for an empty DB', async () => {
    const ctx = makeCtx();
    runMigrations(ctx);
    const out = await getBalance.execute({ period: 'this_month' }, ctx);
    expect(out).toContain('Completed: 0 tasks ($0.00)');
    expect(out).toContain('Net earned: $0.00');
  });

  it('sums earned + decay-weighted values', async () => {
    const ctx = makeCtx();
    runMigrations(ctx);
    const db = ensureDb(ctx.config);
    // 2 EARNED tasks: one full $1.00, one decayed $0.50
    db.prepare(
      `INSERT INTO tasks (id, title, status, earned_status, current_value, source) VALUES (?, ?, 'DONE', 'EARNED', ?, 'telegram')`
    ).run('t1', 'on-time task', 1.0);
    db.prepare(
      `INSERT INTO tasks (id, title, status, earned_status, current_value, source) VALUES (?, ?, 'DONE', 'EARNED', ?, 'telegram')`
    ).run('t2', 'late task', 0.5);
    const out = await getBalance.execute({ period: 'this_month' }, ctx);
    expect(out).toContain('Completed: 2 tasks ($1.50)');
    expect(out).toContain('Net earned: $1.50');
  });

  it('subtracts deductions from net', async () => {
    const ctx = makeCtx();
    runMigrations(ctx);
    const db = ensureDb(ctx.config);
    const month = getCurrentBillingMonth();
    db.prepare(
      `INSERT INTO tasks (id, title, status, earned_status, current_value, source) VALUES (?, ?, 'DONE', 'EARNED', 1.0, 'telegram')`
    ).run('t1', 'good');
    db.prepare(
      `INSERT INTO deductions (id, amount, reason, billing_month) VALUES (?, ?, ?, ?)`
    ).run('d1', 0.25, 'late update', month);
    const out = await getBalance.execute({ period: 'this_month' }, ctx);
    expect(out).toContain('Deductions: -$0.25');
    expect(out).toContain('Net earned: $0.75');
  });

  it('counts OVERDUE tasks as negative debt', async () => {
    const ctx = makeCtx();
    runMigrations(ctx);
    const db = ensureDb(ctx.config);
    db.prepare(
      `INSERT INTO tasks (id, title, status, earned_status, current_value, source) VALUES (?, ?, 'OPEN', 'OVERDUE', ?, 'telegram')`
    ).run('t1', 'past deadline', -0.30);
    const out = await getBalance.execute({ period: 'this_month' }, ctx);
    expect(out).toContain('Overdue: 1 tasks (-$0.30)');
    // computeBalance formats as `$<num>` with a possibly-negative number;
    // result is "$-0.30" not "-$0.30". Matches standalone behavior.
    expect(out).toContain('Net earned: $-0.30');
  });

  it('counts OPEN tasks (with no earned_status) in the "in play" line', async () => {
    const ctx = makeCtx();
    runMigrations(ctx);
    const db = ensureDb(ctx.config);
    db.prepare(
      `INSERT INTO tasks (id, title, status, earned_status, source) VALUES (?, ?, 'OPEN', NULL, 'telegram')`
    ).run('t1', 'in flight');
    const out = await getBalance.execute({ period: 'this_month' }, ctx);
    expect(out).toContain('Open: 1 tasks (in play)');
  });

  it('respects period=all_time vs this_month', async () => {
    const ctx = makeCtx();
    runMigrations(ctx);
    const db = ensureDb(ctx.config);
    // A task created LAST month (using SQLite date arithmetic)
    db.prepare(
      `INSERT INTO tasks (id, title, status, earned_status, current_value, source, created_at)
       VALUES (?, ?, 'DONE', 'EARNED', 1.0, 'telegram', datetime('now', '-2 months'))`
    ).run('old', 'last month task');
    const monthly = await getBalance.execute({ period: 'this_month' }, ctx);
    expect(monthly).toContain('Completed: 0 tasks');
    const allTime = await getBalance.execute({ period: 'all_time' }, ctx);
    expect(allTime).toContain('Completed: 1 tasks');
  });
});
