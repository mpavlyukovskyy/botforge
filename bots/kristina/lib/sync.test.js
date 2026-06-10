/**
 * Tests for reconcile() — the Atlas-as-source-of-truth converge loop.
 * Real in-memory SQLite + a controllable mocked Atlas snapshot.
 * Guards the 2026-06 incidents: ghost reap, dashboard-learn, heal-by-externalId,
 * never-reap-unsynced, and safe-abort on bad snapshots.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
let snapshotResult; // what fetchAtlasSnapshot returns this test

vi.mock('./atlas-client.js', () => ({
  ensureDb: () => db,
  fetchAtlasSnapshot: async () => snapshotResult,
  reconcileDeductions: async () => 0,
  getAtlasConfig: () => ({ url: 'http://x', token: 't' }),
}));
// flags refresh is best-effort + network; stub it out so reconcile tests stay pure.
vi.mock('./flags.js', () => ({ refreshFlags: async () => {}, getFlag: () => false, setFlagsCache: () => {} }));

const { reconcile } = await import('./sync.js');

const ctx = { config: { name: 'test' }, log: { info() {}, warn() {}, error() {} } };

function seed(rows) {
  const ins = db.prepare(
    `INSERT INTO tasks (id, spok_id, title, status, earned_status, deadline, requester_chat_id, synced_at, created_at, updated_at)
     VALUES (@id, @spok_id, @title, @status, @earned_status, @deadline, @chat, @synced_at, datetime('now'), datetime('now'))`
  );
  for (const r of rows) ins.run({
    id: r.id, spok_id: r.spok_id ?? null, title: r.title, status: r.status ?? 'OPEN',
    earned_status: r.earned_status ?? null, deadline: r.deadline ?? null,
    chat: r.chat ?? null, synced_at: r.synced_at ?? null,
  });
}
const ids = () => db.prepare("SELECT id FROM tasks ORDER BY id").all().map(r => r.id);
const bySpok = (s) => db.prepare("SELECT * FROM tasks WHERE spok_id = ?").get(s);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, spok_id TEXT, title TEXT, column_name TEXT, column_id TEXT,
    assignee TEXT, deadline TEXT, status TEXT DEFAULT 'OPEN', earned_status TEXT,
    current_value REAL, requester TEXT, requester_chat_id TEXT, priority_tier TEXT DEFAULT 'STANDARD',
    blocked_at TEXT, blocked_on TEXT, blocked_seconds_total INTEGER DEFAULT 0,
    synced_at TEXT, created_at TEXT, updated_at TEXT);`);
  snapshotResult = [];
});

describe('reconcile — priorityTier round-trip', () => {
  it('learns priorityTier from Atlas on insert', async () => {
    snapshotResult = [{ id: 'cuid_p', title: 'big rock', status: 'OPEN', priorityTier: 'P0' }];
    await reconcile(ctx);
    expect(db.prepare("SELECT priority_tier FROM tasks WHERE spok_id='cuid_p'").get().priority_tier).toBe('P0');
  });
  it('updates priorityTier from Atlas on upsert (Atlas is authority)', async () => {
    db.prepare("INSERT INTO tasks (id, spok_id, title, status, priority_tier) VALUES ('l1','cuid_1','t','OPEN','STANDARD')").run();
    snapshotResult = [{ id: 'cuid_1', title: 't', status: 'OPEN', priorityTier: 'IMPORTANT' }];
    await reconcile(ctx);
    expect(db.prepare("SELECT priority_tier FROM tasks WHERE spok_id='cuid_1'").get().priority_tier).toBe('IMPORTANT');
  });
});

describe('reconcile — ghost reap', () => {
  it('reaps a synced local row that Atlas no longer has (the HSBC ghost)', async () => {
    seed([{ id: 'l1', spok_id: 'cuid_gone', title: 'Login to HSBC', earned_status: 'OVERDUE' }]);
    snapshotResult = [{ id: 'cuid_other', title: 'something else', status: 'OPEN' }];
    const r = await reconcile(ctx);
    expect(r.reaped).toBe(1);
    expect(bySpok('cuid_gone')).toBeUndefined();
  });

  it('reaps a row whose Atlas counterpart is soft-deleted (tombstone)', async () => {
    seed([{ id: 'l1', spok_id: 'cuid_x', title: 'deleted on dashboard' }]);
    snapshotResult = [{ id: 'cuid_x', title: 'deleted on dashboard', status: 'OPEN', deletedAt: '2026-06-09T00:00:00Z' }];
    const r = await reconcile(ctx);
    expect(r.reaped).toBe(1);
    expect(ids()).toEqual([]);
  });
});

describe('reconcile — never reap not-yet-synced', () => {
  it('keeps a spok_id-null local row even though it is absent from Atlas', async () => {
    seed([{ id: 'local-only', spok_id: null, title: 'created offline' }]);
    snapshotResult = [{ id: 'cuid_a', title: 'other', status: 'OPEN' }];
    const r = await reconcile(ctx);
    expect(ids()).toContain('local-only');
    expect(r.reaped).toBe(0);
  });
});

describe('reconcile — learn + heal', () => {
  it('inserts a task that exists in Atlas but not locally (dashboard-created)', async () => {
    snapshotResult = [{ id: 'cuid_new', externalId: null, title: 'made on dashboard', status: 'OPEN' }];
    const r = await reconcile(ctx);
    expect(r.inserted).toBe(1);
    expect(bySpok('cuid_new').title).toBe('made on dashboard');
  });

  it('heals a synced-but-unlinked local row by externalId (sets spok_id)', async () => {
    seed([{ id: 'ext-123', spok_id: null, title: 'created offline, now on atlas' }]);
    snapshotResult = [{ id: 'cuid_linked', externalId: 'ext-123', title: 'created offline, now on atlas', status: 'OPEN' }];
    const r = await reconcile(ctx);
    expect(r.inserted).toBe(0);
    expect(r.upserted).toBe(1);
    expect(bySpok('cuid_linked').id).toBe('ext-123'); // same local row, now linked
    expect(ids()).toEqual(['ext-123']); // no duplicate
  });

  it('updates local status/earned from Atlas truth (Atlas wins)', async () => {
    seed([{ id: 'l1', spok_id: 'cuid_1', title: 't', status: 'OPEN', earned_status: 'OVERDUE' }]);
    snapshotResult = [{ id: 'cuid_1', title: 't', status: 'DONE', earnedStatus: 'EARNED', earnedValue: '1.00' }];
    await reconcile(ctx);
    const row = bySpok('cuid_1');
    expect(row.status).toBe('DONE');
    expect(row.earned_status).toBe('EARNED');
    expect(row.current_value).toBe(1);
  });
});

describe('reconcile — safe-abort (never reap on a bad snapshot)', () => {
  it('aborts when Atlas is unverifiable (snapshot null)', async () => {
    seed([{ id: 'l1', spok_id: 'cuid_gone', title: 'keep me' }]);
    snapshotResult = null;
    const r = await reconcile(ctx);
    expect(r.aborted).toBe('atlas-unverifiable');
    expect(ids()).toEqual(['l1']); // untouched
  });

  it('aborts on suspicious empty snapshot while local is non-empty', async () => {
    seed([{ id: 'l1', spok_id: 'cuid_gone', title: 'keep me' }]);
    snapshotResult = [];
    const r = await reconcile(ctx);
    expect(r.aborted).toBe('suspect-empty');
    expect(ids()).toEqual(['l1']); // untouched
  });
});
