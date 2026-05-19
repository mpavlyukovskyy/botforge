/**
 * Kristina DB — schema migrations and multi-user helpers
 *
 * Called by lifecycle/start.js to ensure schema is up to date.
 * Uses the same SQLite DB as atlas-client.js (via ensureDb).
 */
import { DateTime } from 'luxon';
import { ensureDb } from './atlas-client.js';
import { computeDecayValue } from './decay.js';
import { TIMEZONE } from './working-hours.js';

export function runMigrations(ctx) {
  const db = ensureDb(ctx.config);

  // Add notified_at to tasks if missing
  try { db.exec("ALTER TABLE tasks ADD COLUMN notified_at TEXT"); } catch {}
  // Financial-model columns on tasks (idempotent — try/catch swallows
  // "duplicate column" on re-init). Added in Phase 2 parity port.
  try { db.exec("ALTER TABLE tasks ADD COLUMN earned_status TEXT"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN current_value REAL"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN handed_off_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN handed_off_note TEXT"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN overdue_notified_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN done_synced INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'telegram'"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN telegram_msg_id TEXT"); } catch {}

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

  // registered_chats table
  db.exec(`
    CREATE TABLE IF NOT EXISTS registered_chats (
      chat_id TEXT PRIMARY KEY,
      requester_name TEXT NOT NULL,
      registered_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_registered_chats_name ON registered_chats(requester_name);
  `);

  // Add fund_id to column_cache if missing
  try { db.exec("ALTER TABLE column_cache ADD COLUMN fund_id TEXT"); } catch {}

  // deductions — penalty tracking, drives /balance and record_deduction tool
  db.exec(`
    CREATE TABLE IF NOT EXISTS deductions (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      requester TEXT,
      requester_chat_id TEXT,
      billing_month TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      reversed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deductions_billing ON deductions(billing_month, reversed_at);
  `);

  // nudge_log — per-task per-day record of nudges sent + their resolution.
  // Drives nudge_send + nudge_deductions crons (5pm/7:05pm ET Sun-Thu).
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      nudge_date TEXT NOT NULL,
      sent_at TEXT,
      delivered INTEGER DEFAULT 0,
      responded_at TEXT,
      deduction_applied INTEGER DEFAULT 0,
      deduction_amount_cents INTEGER,
      UNIQUE(task_id, nudge_date)
    );
    CREATE INDEX IF NOT EXISTS idx_nudge_date ON nudge_log(nudge_date);
  `);

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_synced ON tasks(synced_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester);
    CREATE INDEX IF NOT EXISTS idx_tasks_earned_status ON tasks(earned_status);
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_column ON tasks(status, column_name);
    CREATE INDEX IF NOT EXISTS idx_callback_created ON callback_tracking(created_at);
    CREATE INDEX IF NOT EXISTS idx_message_refs_created ON message_refs(created_at);
  `);
}

// ─── Financial model helpers ────────────────────────────────────────────────

/**
 * Current billing month in YYYY-MM ET. Used to bucket deductions + earnings.
 */
export function getCurrentBillingMonth() {
  return DateTime.now().setZone(TIMEZONE).toFormat('yyyy-MM');
}

/**
 * True if the caller is an admin per behavior.access.admin_users in YAML.
 * Compares against BOTH userId and chatId — depending on platform/event
 * shape one or the other carries Mark's 381823289 identifier.
 *
 * Admin status unlocks: full board visibility in query_board, cancel/delete,
 * and changing deadlines on others' tasks.
 */
export function isAdmin(ctx) {
  const adminUsers = ctx.config?.behavior?.access?.admin_users || [];
  return (
    adminUsers.includes(String(ctx.userId)) ||
    adminUsers.includes(String(ctx.chatId))
  );
}

/**
 * Look up a task by ID prefix (first 8 chars of UUID), checking both local
 * id and Atlas spok_id. Returns undefined if not found.
 */
export function findTaskByIdPrefix(ctx, idPrefix) {
  const db = ensureDb(ctx.config);
  return db.prepare(
    'SELECT id, spok_id, title, column_name, deadline, status, earned_status, current_value, handed_off_at, handed_off_note FROM tasks WHERE id LIKE ? OR spok_id LIKE ?'
  ).get(`${idPrefix}%`, `${idPrefix}%`);
}

/**
 * Centralised "mark task done" — used by both the mark_done tool and the
 * update_task tool when moving to Done column. Computes the earned value
 * based on the decay model + handoff status, updates local DB. Returns
 * {earnedValue, financialNote} for use in the user-facing reply.
 *
 * Idempotent: if task is already DONE, returns its existing value.
 */
export function markTaskDoneLocally(ctx, taskId) {
  const db = ensureDb(ctx.config);

  const current = db.prepare(
    "SELECT status, current_value FROM tasks WHERE id = ?"
  ).get(taskId);
  if (current?.status === 'DONE') {
    const val = current.current_value ?? 1.0;
    return {
      earnedValue: val,
      financialNote: val >= 1.0 ? '+$1.00' : `+$${val.toFixed(2)}`,
    };
  }

  const row = db.prepare(
    'SELECT deadline, created_at, handed_off_at FROM tasks WHERE id = ?'
  ).get(taskId);

  let earnedValue = 1.0;
  let financialNote = '+$1.00';
  let daysOverdue = 0;

  if (row?.deadline && row?.created_at) {
    if (row.handed_off_at && new Date(row.handed_off_at) <= new Date(row.deadline)) {
      // Handoff before deadline freezes full bounty
      earnedValue = 1.0;
      financialNote = '+$1.00 (handed off on time)';
    } else {
      const { value, daysOverdue: dOver } = computeDecayValue(row.deadline);
      earnedValue = value;
      daysOverdue = dOver;
      if (value >= 1.0) {
        financialNote = '+$1.00';
      } else if (value > 0) {
        const hoursLate = Math.round(daysOverdue * 10);
        financialNote = `+$${value.toFixed(2)} (${hoursLate}h overdue)`;
      } else {
        const sessions = Math.round(daysOverdue);
        financialNote = `-$${Math.abs(value).toFixed(2)} (${sessions} session${sessions === 1 ? '' : 's'} overdue)`;
      }
    }
  }

  db.prepare(
    `UPDATE tasks
       SET status = 'DONE',
           earned_status = 'EARNED',
           current_value = ?,
           handed_off_at = NULL,
           handed_off_note = NULL,
           overdue_notified_at = NULL,
           done_synced = 0,
           updated_at = datetime('now')
     WHERE id = ?`
  ).run(earnedValue, taskId);

  return { earnedValue, financialNote };
}

/**
 * Compute monthly balance (or all-time) — used by get_balance tool + /balance.
 *
 * @param {object} ctx
 * @param {'this_month'|'all_time'} period
 * @returns {string} formatted multi-line summary
 */
export function computeBalance(ctx, period = 'this_month') {
  const db = ensureDb(ctx.config);
  const useMonth = period === 'this_month';
  const month = getCurrentBillingMonth();
  const monthFilter = useMonth ? " AND strftime('%Y-%m', created_at) = ?" : '';
  const params = useMonth ? [month] : [];

  const decayEarned = db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(current_value), 0) as total
       FROM tasks
      WHERE earned_status = 'EARNED' AND current_value IS NOT NULL${monthFilter}`
  ).get(...params);

  const legacyEarned = db.prepare(
    `SELECT COUNT(*) as count FROM tasks
      WHERE earned_status = 'EARNED' AND current_value IS NULL${monthFilter}`
  ).get(...params);

  const legacyLate = db.prepare(
    `SELECT COUNT(*) as count FROM tasks
      WHERE earned_status = 'LATE' AND current_value IS NULL${monthFilter}`
  ).get(...params);

  const forfeited = db.prepare(
    `SELECT COUNT(*) as count FROM tasks
      WHERE earned_status = 'FORFEITED' AND status = 'OPEN'${monthFilter}`
  ).get(...params);

  const overdue = db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(current_value), 0) as total
       FROM tasks
      WHERE status = 'OPEN' AND earned_status = 'OVERDUE'${monthFilter}`
  ).get(...params);

  const deductionFilter = useMonth ? ' AND billing_month = ?' : '';
  const deductionParams = useMonth ? [month] : [];
  const deductions = db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM deductions WHERE reversed_at IS NULL${deductionFilter}`
  ).get(...deductionParams);

  const open = db.prepare(
    `SELECT COUNT(*) as count FROM tasks
      WHERE status = 'OPEN' AND earned_status IS NULL${monthFilter}`
  ).get(...params);

  const earnedTotal = decayEarned.total + legacyEarned.count * 1.0 + legacyLate.count * 0.5;
  const taskCount = decayEarned.count + legacyEarned.count + legacyLate.count;
  const overdueDebt = overdue.total; // already negative
  const net = earnedTotal - deductions.total + overdueDebt;

  const lines = [`Completed: ${taskCount} tasks ($${earnedTotal.toFixed(2)})`];
  if (forfeited.count > 0) lines.push(`Expired: ${forfeited.count} tasks ($0.00)`);
  if (overdue.count > 0) lines.push(`Overdue: ${overdue.count} tasks (-$${Math.abs(overdueDebt).toFixed(2)})`);
  lines.push(`Deductions: -$${deductions.total.toFixed(2)}`);
  lines.push(`Open: ${open.count} tasks (in play)`);
  lines.push('---');
  lines.push(`Net earned: $${net.toFixed(2)}`);
  return lines.join('\n');
}

// ─── Multi-user helpers ─────────────────────────────────────────────────────

export function getRegisteredChat(ctx, chatId, userId) {
  const db = ensureDb(ctx.config);
  const row = db.prepare('SELECT * FROM registered_chats WHERE chat_id = ?').get(String(chatId));
  if (row) return row;
  if (userId && userId !== chatId && !String(chatId).startsWith('-')) {
    return db.prepare('SELECT * FROM registered_chats WHERE chat_id = ?').get(String(userId));
  }
  return null;
}

export function getAllRegisteredChats(ctx) {
  const db = ensureDb(ctx.config);
  return db.prepare('SELECT * FROM registered_chats').all();
}

export function registerChat(ctx, chatId, requesterName, registeredBy) {
  const db = ensureDb(ctx.config);
  db.prepare(
    'INSERT OR REPLACE INTO registered_chats (chat_id, requester_name, registered_by) VALUES (?, ?, ?)'
  ).run(String(chatId), requesterName, registeredBy || null);
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
