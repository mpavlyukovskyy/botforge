/**
 * Tests for conversation_cleanup robustness — proves the nightly cron no longer
 * aborts when a referenced table (conversation_history) is absent from the
 * botforge tools DB (the 2026-06-14 "no such table: conversation_history"
 * failure), and still cleans the tables that DO exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
vi.mock('../lib/atlas-client.js', () => ({ ensureDb: () => db }));

const ctx = { config: { name: 'Kristina' }, log: { info() {}, warn() {}, error() {} } };

function freshCron() {
  return import('./conversation-cleanup.js').then((m) => m.default);
}

beforeEach(() => {
  db = new Database(':memory:');
  // Seed the tables the real tools DB has — but NOT conversation_history.
  db.exec(`
    CREATE TABLE callback_tracking (id INTEGER PRIMARY KEY, created_at TEXT);
    CREATE TABLE message_refs (id INTEGER PRIMARY KEY, created_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, created_at TEXT);
  `);
  // One stale + one fresh row in each cleanable table.
  db.exec(`
    INSERT INTO callback_tracking (created_at) VALUES (datetime('now','-3 days')), (datetime('now'));
    INSERT INTO message_refs (created_at) VALUES (datetime('now','-10 days')), (datetime('now'));
    INSERT INTO tasks (status, created_at) VALUES ('PENDING', datetime('now','-3 days')), ('PENDING', datetime('now')), ('OPEN', datetime('now','-3 days'));
  `);
});

describe('conversation_cleanup', () => {
  it('does NOT throw when conversation_history is missing', async () => {
    const cron = await freshCron();
    await expect(cron.execute(ctx)).resolves.toBeUndefined();
  });

  it('still cleans the tables that exist (missing table does not block the rest)', async () => {
    const cron = await freshCron();
    await cron.execute(ctx);
    // stale rows removed, fresh rows kept
    expect(db.prepare('SELECT COUNT(*) c FROM callback_tracking').get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM message_refs').get().c).toBe(1);
    // only the stale PENDING task removed; fresh PENDING + old OPEN kept
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get().c).toBe(2);
  });

  it('cleans conversation_history too when the table IS present', async () => {
    db.exec(`CREATE TABLE conversation_history (id INTEGER PRIMARY KEY, created_at TEXT);`);
    db.exec(`INSERT INTO conversation_history (created_at) VALUES (datetime('now','-40 days')), (datetime('now'));`);
    const cron = await freshCron();
    await cron.execute(ctx);
    expect(db.prepare('SELECT COUNT(*) c FROM conversation_history').get().c).toBe(1);
  });
});
