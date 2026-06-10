/**
 * Tests that completing a task EARNS its value — markTaskDoneLocally sets
 * status=DONE + earned_status=EARNED + current_value. Regression guard for the
 * bug where bot-completed tasks earned $0 (the earning logic was dead/uncalled).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
vi.mock('./atlas-client.js', () => ({ ensureDb: () => db }));

const { markTaskDoneLocally, computeBalance } = await import('./db.js');
const ctx = { config: { name: 'test' } };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, spok_id TEXT, title TEXT, status TEXT DEFAULT 'OPEN',
    earned_status TEXT, current_value REAL, deadline TEXT, handed_off_at TEXT,
    handed_off_note TEXT, overdue_notified_at TEXT, done_synced INTEGER DEFAULT 0,
    has_earned INTEGER DEFAULT 0, priority_tier TEXT DEFAULT 'STANDARD', blocked_seconds_total INTEGER DEFAULT 0,
    parent_task_id TEXT, is_project INTEGER DEFAULT 0, value_share INTEGER DEFAULT 1, quality_mult REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
   CREATE TABLE deductions (id TEXT PRIMARY KEY, amount REAL, reason TEXT, requester TEXT,
    requester_chat_id TEXT, billing_month TEXT, created_at TEXT, reversed_at TEXT);`);
});

describe('markTaskDoneLocally — earning', () => {
  it('an on-time task (no deadline) earns full $1.00 and is marked EARNED/DONE', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1','do a thing','OPEN')").run();
    const r = markTaskDoneLocally(ctx, 't1');
    expect(r.earnedValue).toBe(1.0);
    const row = db.prepare("SELECT status, earned_status, current_value FROM tasks WHERE id='t1'").get();
    expect(row.status).toBe('DONE');
    expect(row.earned_status).toBe('EARNED');
    expect(row.current_value).toBe(1.0);
  });

  it('is idempotent — re-marking an already-DONE task returns its value, no double-count', () => {
    db.prepare("INSERT INTO tasks (id, title, status, earned_status, current_value) VALUES ('t2','x','DONE','EARNED',1.0)").run();
    const r = markTaskDoneLocally(ctx, 't2');
    expect(r.earnedValue).toBe(1.0);
    expect(db.prepare("SELECT current_value FROM tasks WHERE id='t2'").get().current_value).toBe(1.0);
  });

  it('a completed task shows up in the balance (was $0 before the fix)', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t3','earn me','OPEN')").run();
    markTaskDoneLocally(ctx, 't3');
    const bal = computeBalance(ctx, 'all_time');
    expect(bal).toMatch(/Completed: 1 tasks \(\$1\.00\)/);
  });
});
