/**
 * SQLite Storage — better-sqlite3 wrapper with versioned migrations
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@botforge/core';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export interface StorageOptions {
  /** Path to SQLite database file */
  path: string;
  /** Enable WAL mode (default: true) */
  wal?: boolean;
  /** Migrations to run */
  migrations?: Migration[];
  /** Logger */
  log?: Logger;
}

export class SqliteStorage {
  readonly db: Database.Database;
  private log?: Logger;

  constructor(options: StorageOptions) {
    this.log = options.log;

    // Ensure directory exists
    const dir = dirname(options.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(options.path);

    // Enable WAL mode for better concurrent performance
    if (options.wal !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    // Standard pragmas
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // Create migrations tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Run migrations
    if (options.migrations?.length) {
      this.runMigrations(options.migrations);
    }
  }

  private runMigrations(migrations: Migration[]): void {
    const applied = new Set(
      this.db.prepare('SELECT version FROM _migrations').all()
        .map((row) => (row as { version: number }).version)
    );

    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    for (const migration of sorted) {
      if (applied.has(migration.version)) continue;

      this.log?.info(`Running migration v${migration.version}: ${migration.name}`);

      this.db.transaction(() => {
        this.db.exec(migration.up);
        this.db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)')
          .run(migration.version, migration.name);
      })();
    }
  }

  /** Get current migration version */
  getVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) as v FROM _migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  /** Get database file size in bytes */
  getSize(): number {
    const row = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
    return row.size;
  }

  /** Backup database to a file */
  backup(destPath: string): void {
    this.db.backup(destPath);
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}

// ─── Conversation History (shared pattern) ───────────────────────────────────

export const CONVERSATION_HISTORY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_conversation_history',
    up: `
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conv_hist_chat_id ON conversation_history(chat_id);
      CREATE INDEX IF NOT EXISTS idx_conv_hist_created_at ON conversation_history(created_at);
    `,
  },
  {
    version: 2,
    name: 'add_sessions',
    up: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        started_at TEXT DEFAULT (datetime('now')),
        last_message_at TEXT DEFAULT (datetime('now')),
        summary TEXT,
        status TEXT DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, chat_id);
    `,
  },
  {
    version: 3,
    name: 'add_session_id_to_history',
    up: `
      ALTER TABLE conversation_history ADD COLUMN session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_conv_hist_session_id ON conversation_history(session_id);
    `,
  },
];

export interface ConversationMessage {
  id: number;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  metadata?: string;
  session_id?: string;
}

export class ConversationHistoryStore {
  private db: Database.Database;
  private maxMessages: number;
  private ttlDays: number;
  private stripActionLines: boolean;
  private sessionTimeoutMinutes: number;

  constructor(
    storage: SqliteStorage,
    options: { maxMessages?: number; ttlDays?: number; stripActionLines?: boolean; sessionTimeoutMinutes?: number } = {}
  ) {
    this.db = storage.db;
    this.maxMessages = options.maxMessages ?? 100;
    this.ttlDays = options.ttlDays ?? 14;
    this.stripActionLines = options.stripActionLines ?? false;
    this.sessionTimeoutMinutes = options.sessionTimeoutMinutes ?? 120;
  }

  /** Add a message to conversation history */
  add(chatId: string, role: 'user' | 'assistant', content: string, metadata?: Record<string, unknown>): void {
    if (!content?.trim()) return;
    let processedContent = content;
    if (this.stripActionLines && role === 'assistant') {
      processedContent = content
        .split('\n')
        .filter(line => !line.startsWith('ACTION:'))
        .join('\n')
        .trim();
    }

    // Get or create session
    const { sessionId } = this.getOrCreateSession(chatId);

    this.db.prepare(`
      INSERT INTO conversation_history (chat_id, role, content, metadata, session_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(chatId, role, processedContent, metadata ? JSON.stringify(metadata) : null, sessionId);

    this.touchSession(sessionId);
  }

  /** Get recent conversation history for a chat */
  getRecent(chatId: string, limit?: number): ConversationMessage[] {
    return this.db.prepare(`
      SELECT * FROM conversation_history
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, limit ?? this.maxMessages) as ConversationMessage[];
  }

  /** Format history as a context block for system prompt injection */
  formatAsContextBlock(chatId: string): string {
    const { sessionId, previousSummary } = this.getOrCreateSession(chatId);

    const messages = this.db.prepare(`
      SELECT * FROM conversation_history
      WHERE chat_id = ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, sessionId, this.maxMessages) as ConversationMessage[];

    const reversed = messages.reverse();

    const parts: string[] = [];

    if (previousSummary) {
      parts.push(`<previous_session>${previousSummary}</previous_session>`);
    }

    if (reversed.length > 0) {
      const lines = reversed.map(m =>
        `[${m.created_at}] ${m.role}: ${m.content}`
      );
      parts.push(`<recent_conversation_history>\n${lines.join('\n')}\n</recent_conversation_history>`);
    }

    return parts.join('\n');
  }

  /** Get the timestamp of the last message in a chat */
  getLastMessageTime(chatId: string): Date | null {
    const row = this.db.prepare(
      'SELECT MAX(created_at) as last_time FROM conversation_history WHERE chat_id = ?'
    ).get(chatId) as { last_time: string | null } | undefined;
    return row?.last_time ? new Date(row.last_time) : null;
  }

  /** Get distinct chat IDs with messages within the given timeframe */
  getRecentChatIds(withinMinutes: number): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT chat_id FROM conversation_history
       WHERE created_at > datetime('now', ?)
       ORDER BY created_at DESC`
    ).all(`-${withinMinutes} minutes`) as { chat_id: string }[];
    return rows.map(r => r.chat_id);
  }

  /** Delete messages older than TTL */
  cleanup(): number {
    const result = this.db.prepare(`
      DELETE FROM conversation_history
      WHERE created_at < datetime('now', ?)
    `).run(`-${this.ttlDays} days`);

    return result.changes;
  }

  /** Get or create an active session for a chat */
  getOrCreateSession(chatId: string): { sessionId: string; isNew: boolean; previousSummary?: string } {
    const active = this.db.prepare(
      `SELECT id, last_message_at FROM sessions
       WHERE chat_id = ? AND status = 'active'
       ORDER BY last_message_at DESC LIMIT 1`
    ).get(chatId) as { id: string; last_message_at: string } | undefined;

    if (active) {
      const lastMsg = new Date(active.last_message_at + 'Z');
      const elapsed = (Date.now() - lastMsg.getTime()) / (1000 * 60);

      if (elapsed < this.sessionTimeoutMinutes) {
        return { sessionId: active.id, isNew: false };
      }

      // Session timed out — close it and create new one
      const summary = this.closeSession(active.id);
      const newId = randomUUID();
      this.db.prepare(
        `INSERT INTO sessions (id, chat_id) VALUES (?, ?)`
      ).run(newId, chatId);

      return { sessionId: newId, isNew: true, previousSummary: summary ?? undefined };
    }

    // No active session — create one
    const newId = randomUUID();
    this.db.prepare(
      `INSERT INTO sessions (id, chat_id) VALUES (?, ?)`
    ).run(newId, chatId);

    // Check for previous session summary
    const lastClosed = this.db.prepare(
      `SELECT summary FROM sessions
       WHERE chat_id = ? AND status = 'closed' AND summary IS NOT NULL
       ORDER BY last_message_at DESC LIMIT 1`
    ).get(chatId) as { summary: string } | undefined;

    return { sessionId: newId, isNew: true, previousSummary: lastClosed?.summary };
  }

  /** Close a session and generate its summary */
  private closeSession(sessionId: string): string | null {
    const messages = this.db.prepare(
      `SELECT role, content FROM conversation_history
       WHERE session_id = ? ORDER BY created_at ASC LIMIT 50`
    ).all(sessionId) as { role: string; content: string }[];

    let summary: string | null = null;
    if (messages.length > 0) {
      const topics: string[] = [];
      for (const msg of messages) {
        if (msg.role === 'user' && msg.content.length > 10) {
          topics.push(msg.content.slice(0, 100));
        }
      }
      summary = topics.length > 0
        ? `Previous conversation (${messages.length} messages): ${topics.slice(0, 3).join('; ')}`
        : `Previous conversation: ${messages.length} messages`;
    }

    this.db.prepare(
      `UPDATE sessions SET status = 'closed', summary = ? WHERE id = ?`
    ).run(summary, sessionId);

    return summary;
  }

  /** Update session last_message_at */
  touchSession(sessionId: string): void {
    this.db.prepare(
      `UPDATE sessions SET last_message_at = datetime('now') WHERE id = ?`
    ).run(sessionId);
  }
}
