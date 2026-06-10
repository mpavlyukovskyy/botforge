/**
 * Tests the create_task tier clamp: only Mark (admin) can set a tier above
 * STANDARD; a non-admin's tier request is clamped (anti self-assign / anti
 * priority-gaming).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
let admin = true;
const createItemSpy = vi.fn(async () => ({ id: 'cuid_new', atlasId: 'cuid_new' }));

vi.mock('../lib/atlas-client.js', () => ({
  ensureDb: () => db,
  getColumns: async () => [{ id: 'c1', name: 'To Do' }],
  findColumnByName: () => ({ id: 'c1', name: 'To Do' }),
  createItem: createItemSpy,
  updateItem: async () => true,
}));
vi.mock('../lib/db.js', () => ({
  getRegisteredChat: () => ({ requester_name: 'Mark' }),
  isAdmin: () => admin,
}));

const createTask = (await import('./create_task.js')).default;
const ctx = { config: { name: 'test' }, chatId: '1', userId: '1', userName: 'Mark', store: { set() {} }, log: { info() {}, warn() {} } };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, spok_id TEXT, title TEXT, column_name TEXT,
    column_id TEXT, assignee TEXT, deadline TEXT, status TEXT DEFAULT 'OPEN', requester TEXT,
    requester_chat_id TEXT, priority_tier TEXT DEFAULT 'STANDARD', synced_at TEXT, created_at TEXT, updated_at TEXT);
   CREATE TABLE task_subtasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, title TEXT, display_order INT, synced_at TEXT);`);
  createItemSpy.mockClear();
  admin = true;
});

describe('create_task tier clamp', () => {
  it('admin (Mark) can set P0', async () => {
    admin = true;
    await createTask.execute({ title: 'urgent thing', tier: 'P0' }, ctx);
    expect(createItemSpy).toHaveBeenCalledOnce();
    expect(createItemSpy.mock.calls[0][1].priorityTier).toBe('P0');
    expect(db.prepare("SELECT priority_tier FROM tasks WHERE title='urgent thing'").get().priority_tier).toBe('P0');
  });

  it('admin synonym maps (drop everything → P0)', async () => {
    admin = true;
    await createTask.execute({ title: 'now thing', tier: 'drop everything' }, ctx);
    expect(createItemSpy.mock.calls[0][1].priorityTier).toBe('P0');
  });

  it('non-admin is CLAMPED to STANDARD even when requesting P0', async () => {
    admin = false;
    await createTask.execute({ title: 'sneaky p0', tier: 'P0' }, ctx);
    expect(createItemSpy.mock.calls[0][1].priorityTier).toBe('STANDARD');
    expect(db.prepare("SELECT priority_tier FROM tasks WHERE title='sneaky p0'").get().priority_tier).toBe('STANDARD');
  });

  it('no tier → STANDARD', async () => {
    admin = true;
    await createTask.execute({ title: 'plain task' }, ctx);
    expect(createItemSpy.mock.calls[0][1].priorityTier).toBe('STANDARD');
  });
});
