/**
 * Atlas DB — schema migrations and helpers
 *
 * Called by lifecycle/start.js to ensure schema is up to date.
 * Uses the same SQLite DB as spok-client.js (via ensureDb).
 *
 * No registered_chats table — Atlas is a shared group bot,
 * not a per-user personal assistant.
 */
import { ensureDb } from './spok-client.js';

export function runMigrations(ctx) {
  const db = ensureDb(ctx.config);

  // callback_tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS callback_tracking (
      msg_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      acted INTEGER DEFAULT 0,
      action_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // message_refs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_refs (
      msg_id TEXT NOT NULL,
      ref_num INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      spok_id TEXT,
      title TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (msg_id, ref_num)
    )
  `);

  // task_attachments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data TEXT,
      filename TEXT,
      mime_type TEXT,
      telegram_file_id TEXT,
      url TEXT,
      link_title TEXT,
      display_order INTEGER DEFAULT 0,
      synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add image_base64 column for photo attachments (migration)
  try { db.exec("ALTER TABLE task_attachments ADD COLUMN image_base64 TEXT"); } catch {}

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_synced ON tasks(synced_at);
    CREATE INDEX IF NOT EXISTS idx_callback_created ON callback_tracking(created_at);
    CREATE INDEX IF NOT EXISTS idx_message_refs_created ON message_refs(created_at);
  `);
}

// ─── Message refs helpers ───────────────────────────────────────────────────

export function storeMessageRefs(ctx, msgId, refs) {
  const db = ensureDb(ctx.config);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO message_refs (msg_id, ref_num, task_id, spok_id, title) VALUES (?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const ref of refs) {
      insert.run(String(msgId), ref.num, ref.taskId, ref.spokId || null, ref.title || null);
    }
  });
  tx();
}

export function loadMessageRefs(ctx, msgId) {
  const db = ensureDb(ctx.config);
  return db.prepare('SELECT * FROM message_refs WHERE msg_id = ? ORDER BY ref_num').all(String(msgId));
}

// ─── Callback tracking helpers ──────────────────────────────────────────────

export function trackCallback(ctx, msgId, taskId) {
  const db = ensureDb(ctx.config);
  db.prepare(
    'INSERT OR REPLACE INTO callback_tracking (msg_id, task_id) VALUES (?, ?)'
  ).run(String(msgId), taskId);
}

export function isCallbackStale(ctx, msgId) {
  const db = ensureDb(ctx.config);
  const row = db.prepare(
    "SELECT * FROM callback_tracking WHERE msg_id = ? AND (acted = 1 OR created_at < datetime('now', '-48 hours'))"
  ).get(String(msgId));
  return !!row;
}

export function markCallbackActed(ctx, msgId, actionType) {
  const db = ensureDb(ctx.config);
  db.prepare(
    'UPDATE callback_tracking SET acted = 1, action_type = ? WHERE msg_id = ?'
  ).run(actionType || null, String(msgId));
}
