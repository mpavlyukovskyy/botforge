/**
 * S8: milestone value PARTITIONS the parent's tiered value (never multiplies).
 * An IMPORTANT (3x) project split into N milestones pays 3 total (sum of slices),
 * NOT 3*N. The project container itself earns 0.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
vi.mock('./atlas-client.js', () => ({ ensureDb: () => db }));
vi.mock('./flags.js', () => ({ getFlag: () => true })); // v2 ON for these tests

const { markTaskDoneLocally } = await import('./db.js');
const ctx = { config: { name: 't' } };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, spok_id TEXT, status TEXT DEFAULT 'OPEN', earned_status TEXT,
    current_value REAL, deadline TEXT, created_at TEXT, handed_off_at TEXT, handed_off_note TEXT,
    overdue_notified_at TEXT, done_synced INTEGER DEFAULT 0, has_earned INTEGER DEFAULT 0,
    priority_tier TEXT DEFAULT 'STANDARD', blocked_seconds_total INTEGER DEFAULT 0,
    parent_task_id TEXT, is_project INTEGER DEFAULT 0, value_share INTEGER DEFAULT 1, quality_mult REAL DEFAULT 1.0, updated_at TEXT);`);
});

describe('milestone partition', () => {
  it('an IMPORTANT(3x) project split into 3 equal milestones pays 3 total, not 9', () => {
    db.prepare("INSERT INTO tasks (id, status, priority_tier, is_project) VALUES ('proj','OPEN','IMPORTANT',1)").run();
    for (const m of ['m1', 'm2', 'm3']) {
      db.prepare("INSERT INTO tasks (id, status, parent_task_id, value_share) VALUES (?, 'OPEN', 'proj', 1)").run(m);
    }
    const total = ['m1', 'm2', 'm3'].reduce((s, m) => s + markTaskDoneLocally(ctx, m).earnedValue, 0);
    expect(total).toBeCloseTo(3.0, 5); // == parent's tiered value, NOT 3x3=9
  });

  it('unequal shares split proportionally (2:1:1 of a STANDARD project = 0.5/0.25/0.25)', () => {
    db.prepare("INSERT INTO tasks (id, status, priority_tier, is_project) VALUES ('p2','OPEN','STANDARD',1)").run();
    db.prepare("INSERT INTO tasks (id, status, parent_task_id, value_share) VALUES ('a','OPEN','p2',2)").run();
    db.prepare("INSERT INTO tasks (id, status, parent_task_id, value_share) VALUES ('b','OPEN','p2',1)").run();
    db.prepare("INSERT INTO tasks (id, status, parent_task_id, value_share) VALUES ('c','OPEN','p2',1)").run();
    expect(markTaskDoneLocally(ctx, 'a').earnedValue).toBe(0.5);
    expect(markTaskDoneLocally(ctx, 'b').earnedValue).toBe(0.25);
    expect(markTaskDoneLocally(ctx, 'c').earnedValue).toBe(0.25);
  });

  it('the project container itself earns 0', () => {
    db.prepare("INSERT INTO tasks (id, status, priority_tier, is_project) VALUES ('proj','OPEN','P0',1)").run();
    expect(markTaskDoneLocally(ctx, 'proj').earnedValue).toBe(0);
  });
});
