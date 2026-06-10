/**
 * S5: completing a task multiplies the (decay-aware) value by its priority tier
 * when INCENTIVE_V2 is ON; OFF == today (no tier weighting). hasEarned prevents
 * a reopen->redo from paying twice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
let flagOn = false;

vi.mock('./atlas-client.js', () => ({ ensureDb: () => db }));
vi.mock('./flags.js', () => ({ getFlag: (n) => n === 'INCENTIVE_V2' && flagOn }));

const { markTaskDoneLocally } = await import('./db.js');
const ctx = { config: { name: 't' } };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT DEFAULT 'OPEN', earned_status TEXT,
    current_value REAL, deadline TEXT, created_at TEXT, handed_off_at TEXT, handed_off_note TEXT,
    overdue_notified_at TEXT, done_synced INTEGER DEFAULT 0, has_earned INTEGER DEFAULT 0,
    priority_tier TEXT DEFAULT 'STANDARD', updated_at TEXT);`);
  flagOn = false;
});

describe('markTaskDoneLocally — tier multiplier (S5)', () => {
  it('OFF: an on-time P0 task earns the plain $1.00 (no tier weighting, == today)', () => {
    db.prepare("INSERT INTO tasks (id, status, priority_tier) VALUES ('t1','OPEN','P0')").run();
    flagOn = false;
    expect(markTaskDoneLocally(ctx, 't1').earnedValue).toBe(1.0);
  });

  it('ON: an on-time P0 task earns 8x = $8.00', () => {
    db.prepare("INSERT INTO tasks (id, status, priority_tier) VALUES ('t1','OPEN','P0')").run();
    flagOn = true;
    expect(markTaskDoneLocally(ctx, 't1').earnedValue).toBe(8.0);
    expect(db.prepare("SELECT has_earned FROM tasks WHERE id='t1'").get().has_earned).toBe(1);
  });

  it('ON: IMPORTANT=3x, ROUTINE=0.5x, STANDARD=1x', () => {
    flagOn = true;
    for (const [tier, exp] of [['IMPORTANT', 3], ['ROUTINE', 0.5], ['STANDARD', 1]]) {
      db.prepare("INSERT INTO tasks (id, status, priority_tier) VALUES (?, 'OPEN', ?)").run(`k_${tier}`, tier);
      expect(markTaskDoneLocally(ctx, `k_${tier}`).earnedValue).toBe(exp);
    }
  });

  it('no-double-pay: a re-completed (has_earned) task returns frozen value, not re-credited', () => {
    db.prepare("INSERT INTO tasks (id, status, priority_tier, current_value, has_earned) VALUES ('t1','OPEN','P0', 8.0, 1)").run();
    flagOn = true;
    // even though status is OPEN (reopened), has_earned=1 => return frozen 8.0, no 8x-again
    expect(markTaskDoneLocally(ctx, 't1').earnedValue).toBe(8.0);
  });
});
