/**
 * S6: block_task / unblock_task — "waiting on X" pauses nudges/decay/charges.
 * Dedicated blocked_at/blocked_on (not handoff). Owner-or-Mark auth. unblock
 * accrues blocked_seconds_total for fair decay resumption (S7).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
let admin = false;
const updateSpy = vi.fn(async () => true);

vi.mock('../lib/atlas-client.js', () => ({
  ensureDb: () => db,
  findTaskByIdPrefix: (_ctx, p) => db.prepare('SELECT id, spok_id, title, requester_chat_id, blocked_at FROM tasks WHERE id LIKE ? OR spok_id LIKE ?').get(`${p}%`, `${p}%`),
  updateItem: updateSpy,
}));
vi.mock('../lib/db.js', () => ({ isAdmin: () => admin }));

const blockTask = (await import('./block_task.js')).default;
const unblockTask = (await import('./unblock_task.js')).default;
const ctx = (chatId = '555') => ({ config: { name: 't' }, chatId, log: { warn() {}, info() {} } });

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, spok_id TEXT, title TEXT, requester_chat_id TEXT,
    blocked_at TEXT, blocked_on TEXT, blocked_seconds_total INTEGER DEFAULT 0, updated_at TEXT);`);
  db.prepare("INSERT INTO tasks (id, spok_id, title, requester_chat_id) VALUES ('t1','cuid1','hotel rebooking','555')").run();
  admin = false; updateSpy.mockClear();
});

describe('block_task', () => {
  it('owner blocks → blocked_at set + categorized blocker + Atlas patched', async () => {
    const out = await blockTask.execute({ item_id: 't1', blocked_on: 'booking.com support' }, ctx('555'));
    expect(out).toMatch(/Paused/i);
    const r = db.prepare("SELECT blocked_at, blocked_on FROM tasks WHERE id='t1'").get();
    expect(r.blocked_at).toBeTruthy();
    expect(r.blocked_on).toBe('VENDOR');
    expect(updateSpy).toHaveBeenCalledWith(expect.anything(), 'cuid1', expect.objectContaining({ blockedOn: 'VENDOR' }));
  });
  it('categorizes "Mark" as MARK', async () => {
    await blockTask.execute({ item_id: 't1', blocked_on: 'waiting on Mark' }, ctx('555'));
    expect(db.prepare("SELECT blocked_on FROM tasks WHERE id='t1'").get().blocked_on).toBe('MARK');
  });
  it('non-owner non-admin cannot block', async () => {
    const out = await blockTask.execute({ item_id: 't1' }, ctx('999'));
    expect(out).toMatch(/only block your own/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('unblock_task', () => {
  it('unblock clears state + accrues blocked_seconds_total', async () => {
    db.prepare("UPDATE tasks SET blocked_at = datetime('now','-1 hour'), blocked_on='VENDOR' WHERE id='t1'").run();
    const out = await unblockTask.execute({ item_id: 't1' }, ctx('555'));
    expect(out).toMatch(/Resumed/i);
    const r = db.prepare("SELECT blocked_at, blocked_seconds_total FROM tasks WHERE id='t1'").get();
    expect(r.blocked_at).toBeNull();
    expect(r.blocked_seconds_total).toBeGreaterThanOrEqual(3500); // ~1h
  });
  it('says not-blocked when it isn\'t', async () => {
    expect(await unblockTask.execute({ item_id: 't1' }, ctx('555'))).toMatch(/isn't blocked/i);
  });
});
