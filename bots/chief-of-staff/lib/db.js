/**
 * Chief of Staff DB — schema migrations and helpers
 *
 * Two DB connections:
 * 1. Read-write: chief-of-staff's own DB (commitments, KB metadata, learning)
 * 2. Read-only: email-intel DB (emails, contacts, customers) — see email-intel-db.js
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

// ─── Database singleton ─────────────────────────────────────────────────────

let _db;

export function ensureDb(config) {
  if (!_db) {
    mkdirSync('data', { recursive: true });
    _db = new Database(`data/${config.name}-tools.db`);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function getDb(config) {
  return ensureDb(config);
}

// ─── Migrations ─────────────────────────────────────────────────────────────

export function runMigrations(ctx) {
  const db = ensureDb(ctx.config);

  // ── Knowledge Base pages ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_pages (
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      entity_type TEXT,
      entity_name TEXT,
      last_updated TEXT DEFAULT (datetime('now')),
      dirty INTEGER DEFAULT 0,
      word_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kb_category ON kb_pages(category);
    CREATE INDEX IF NOT EXISTS idx_kb_dirty ON kb_pages(dirty);
    CREATE INDEX IF NOT EXISTS idx_kb_entity ON kb_pages(entity_type, entity_name);
  `);

  // FTS5 virtual table for full-text search over KB
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_pages_fts USING fts5(
      path, title, content,
      content=kb_pages,
      content_rowid=rowid
    );
  `);

  // Triggers to keep FTS in sync
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_pages_ai AFTER INSERT ON kb_pages BEGIN
        INSERT INTO kb_pages_fts(rowid, path, title, content)
        VALUES (new.rowid, new.path, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS kb_pages_ad AFTER DELETE ON kb_pages BEGIN
        INSERT INTO kb_pages_fts(kb_pages_fts, rowid, path, title, content)
        VALUES ('delete', old.rowid, old.path, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS kb_pages_au AFTER UPDATE ON kb_pages BEGIN
        INSERT INTO kb_pages_fts(kb_pages_fts, rowid, path, title, content)
        VALUES ('delete', old.rowid, old.path, old.title, old.content);
        INSERT INTO kb_pages_fts(rowid, path, title, content)
        VALUES (new.rowid, new.path, new.title, new.content);
      END;
    `);
  } catch {
    // Triggers may already exist
  }

  // ── Commitments ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,

      bearer TEXT NOT NULL,
      counterparty TEXT NOT NULL,

      description TEXT NOT NULL,
      condition_text TEXT,
      source_snippet TEXT,

      due_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      fulfilled_at TEXT,

      status TEXT DEFAULT 'active',
      blocker_id TEXT,

      source_type TEXT,
      source_ref TEXT,

      customer TEXT,
      project TEXT,
      priority TEXT DEFAULT 'normal',

      last_followup_at TEXT,
      followup_count INTEGER DEFAULT 0,
      next_followup_date TEXT,

      parent_id TEXT,
      depends_on TEXT,

      confidence REAL DEFAULT 1.0
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
    CREATE INDEX IF NOT EXISTS idx_commitments_type ON commitments(type);
    CREATE INDEX IF NOT EXISTS idx_commitments_bearer ON commitments(bearer);
    CREATE INDEX IF NOT EXISTS idx_commitments_counterparty ON commitments(counterparty);
    CREATE INDEX IF NOT EXISTS idx_commitments_customer ON commitments(customer);
    CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(due_date);
    CREATE INDEX IF NOT EXISTS idx_commitments_priority ON commitments(priority);
    CREATE INDEX IF NOT EXISTS idx_commitments_next_followup ON commitments(next_followup_date);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS commitment_events (
      id TEXT PRIMARY KEY,
      commitment_id TEXT NOT NULL REFERENCES commitments(id),
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_commitment_events_cid ON commitment_events(commitment_id);
  `);

  // ── Email classification cache ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_classifications (
      email_id INTEGER PRIMARY KEY,
      classification TEXT NOT NULL,
      urgency TEXT DEFAULT 'normal',
      action_required INTEGER DEFAULT 0,
      draft_needed INTEGER DEFAULT 0,
      summary TEXT,
      classified_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Calendar events cache ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      event_id TEXT PRIMARY KEY,
      summary TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      attendees TEXT,
      location TEXT,
      description TEXT,
      briefing_sent INTEGER DEFAULT 0,
      synced_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cal_start ON calendar_events(start_time);
    CREATE INDEX IF NOT EXISTS idx_cal_briefing ON calendar_events(briefing_sent);
  `);

  // ── Draft feedback (learning loop) ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS draft_feedback (
      id TEXT PRIMARY KEY,
      commitment_id TEXT,
      recipient TEXT,
      recipient_type TEXT,
      topic TEXT,
      original_draft TEXT,
      final_sent TEXT,
      edit_distance REAL,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_draft_feedback_type ON draft_feedback(recipient_type, topic);
  `);

  // ── Briefing action tracking (learning loop) ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS briefing_actions (
      id TEXT PRIMARY KEY,
      commitment_id TEXT,
      item_type TEXT,
      presented_at TEXT,
      action TEXT,
      acted_at TEXT,
      response_time_seconds INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Extraction feedback (learning loop) ───────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_feedback (
      id TEXT PRIMARY KEY,
      source_ref TEXT,
      extracted_text TEXT,
      system_classification TEXT,
      mark_classification TEXT,
      is_false_positive INTEGER DEFAULT 0,
      is_false_negative INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Gmail draft tracking ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_drafts (
      draft_id TEXT PRIMARY KEY,
      message_id TEXT,
      thread_id TEXT,
      to_address TEXT,
      subject TEXT,
      body_preview TEXT,
      commitment_id TEXT,
      telegram_msg_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      acted_at TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON gmail_drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_telegram ON gmail_drafts(telegram_msg_id);
  `);

  // Add columns for SMTP sending (stores full draft body locally)
  try { db.exec('ALTER TABLE gmail_drafts ADD COLUMN body_text TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE gmail_drafts ADD COLUMN in_reply_to TEXT'); } catch { /* exists */ }

  // ── Audit log ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Contact frequency tracking ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_tracking (
      email TEXT PRIMARY KEY,
      display_name TEXT,
      customer TEXT,
      tier TEXT,
      last_contact_date TEXT,
      contact_count_30d INTEGER DEFAULT 0,
      target_cadence_days INTEGER,
      last_updated TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_tracking_customer ON contact_tracking(customer);
    CREATE INDEX IF NOT EXISTS idx_contact_tracking_last ON contact_tracking(last_contact_date);
  `);

  // ── Priority queue ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS priority_queue (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      from_address TEXT NOT NULL,
      from_name TEXT,
      subject TEXT,
      contact_category TEXT,
      customer_name TEXT,
      customer_tier INTEGER,

      priority_score REAL NOT NULL DEFAULT 0.0,
      priority_factors TEXT,

      status TEXT DEFAULT 'pending',
      draft_id TEXT,
      draft_status TEXT DEFAULT 'none',

      summary TEXT,
      inserted_at TEXT DEFAULT (datetime('now')),
      presented_at TEXT,
      acted_at TEXT,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pq_status_score ON priority_queue(status, priority_score DESC);
    CREATE INDEX IF NOT EXISTS idx_pq_thread ON priority_queue(thread_id);
    CREATE INDEX IF NOT EXISTS idx_pq_draft_status ON priority_queue(draft_status);
    CREATE INDEX IF NOT EXISTS idx_pq_message ON priority_queue(message_id);
  `);

  // ── Person profiles ─────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_profiles (
      email TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      role TEXT,
      company TEXT,
      category TEXT,
      relationship_to_mark TEXT,

      formality_level TEXT DEFAULT 'professional',
      response_cadence TEXT,
      communication_notes TEXT,

      topics_json TEXT DEFAULT '[]',
      open_items_json TEXT DEFAULT '[]',
      last_interaction_summary TEXT,
      last_interaction_date TEXT,

      confidence REAL DEFAULT 0.5,
      kb_path TEXT,
      last_compiled_at TEXT,
      stale INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_category ON person_profiles(category);
    CREATE INDEX IF NOT EXISTS idx_profiles_stale ON person_profiles(stale);
  `);

  // ── Email topics ────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_topics (
      message_id TEXT NOT NULL,
      topic_slug TEXT NOT NULL,
      confidence REAL DEFAULT 0.7,
      extracted_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, topic_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_email_topics_slug ON email_topics(topic_slug);
  `);
}

// ─── Audit helpers ──────────────────────────────────────────────────────────

export function logAudit(ctx, action, detail) {
  const db = ensureDb(ctx.config);
  db.prepare('INSERT INTO audit_log (action, detail) VALUES (?, ?)').run(action, detail || null);
}

// ─── Registered chats (same pattern as kristina) ────────────────────────────

export function registerChat(ctx, chatId, name, source) {
  const db = ensureDb(ctx.config);
  db.exec(`
    CREATE TABLE IF NOT EXISTS registered_chats (
      chat_id TEXT PRIMARY KEY,
      requester_name TEXT NOT NULL,
      registered_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare(
    'INSERT OR REPLACE INTO registered_chats (chat_id, requester_name, registered_by) VALUES (?, ?, ?)'
  ).run(String(chatId), name, source || null);
}

export function getRegisteredChat(ctx, chatId) {
  const db = ensureDb(ctx.config);
  try {
    return db.prepare('SELECT * FROM registered_chats WHERE chat_id = ?').get(String(chatId));
  } catch {
    return null;
  }
}

export function getAllRegisteredChats(ctx) {
  const db = ensureDb(ctx.config);
  try {
    return db.prepare('SELECT * FROM registered_chats').all();
  } catch {
    return [];
  }
}
