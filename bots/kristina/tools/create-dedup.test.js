/**
 * Tests the create_task dedup guard — structurally prevents recreating a task
 * that already exists OPEN (the handoff-duplicate / recreate-on-can't-see class,
 * incidents 2026-06-07/09).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
const createItemSpy = vi.fn(async () => ({ id: 'cuid_new', atlasId: 'cuid_new' }));

vi.mock('../lib/atlas-client.js', () => ({
  ensureDb: () => db,
  getColumns: async () => [{ id: 'c1', name: 'To Do' }],
  findColumnByName: () => ({ id: 'c1', name: 'To Do' }),
  createItem: createItemSpy,
  updateItem: async () => true,
}));
vi.mock('../lib/db.js', () => ({ getRegisteredChat: () => ({ requester_name: 'Mark' }) }));

const createTask = (await import('./create_task.js')).default;

const ctx = { config: { name: 'test' }, chatId: '1', userId: '1', userName: 'Mark', store: { set() {} }, log: { info() {}, warn() {} } };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, spok_id TEXT, title TEXT, column_name TEXT,
    column_id TEXT, assignee TEXT, deadline TEXT, status TEXT DEFAULT 'OPEN', requester TEXT,
    requester_chat_id TEXT, synced_at TEXT, created_at TEXT, updated_at TEXT);
   CREATE TABLE task_subtasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, title TEXT, display_order INT, synced_at TEXT);`);
  createItemSpy.mockClear();
});

describe('create_task dedup guard', () => {
  it('refuses to create a duplicate of an existing OPEN task (case/space-insensitive)', async () => {
    db.prepare("INSERT INTO tasks (id, spok_id, title, status, column_name) VALUES ('e1','cuidexist','Change hotel reservation','OPEN','To Do')").run();
    const out = await createTask.execute({ title: '  change HOTEL reservation ' }, ctx);
    expect(out).toMatch(/already exists/i);
    expect(out).toMatch(/cuidexis/); // points at the existing id
    expect(createItemSpy).not.toHaveBeenCalled(); // no duplicate created
    expect(db.prepare("SELECT COUNT(*) n FROM tasks").get().n).toBe(1);
  });

  it('creates normally when no duplicate exists', async () => {
    const out = await createTask.execute({ title: 'a brand new task' }, ctx);
    expect(out).toMatch(/Created/i);
    expect(createItemSpy).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT COUNT(*) n FROM tasks").get().n).toBe(1);
  });

  it('does not block a DONE-logging create (args.done) even if a same-title OPEN exists', async () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('e1','log it','OPEN')").run();
    const out = await createTask.execute({ title: 'log it', done: true }, ctx);
    expect(out).toMatch(/Created/i);
  });
});
