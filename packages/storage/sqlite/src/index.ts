/**
 * SQLite Storage — better-sqlite3 wrapper with versioned migrations
 */

import Database from 'better-sqlite3';
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
];

export interface ConversationMessage {
  id: number;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  metadata?: string;
}

export class ConversationHistoryStore {
  private db: Database.Database;
  private maxMessages: number;
  private ttlDays: number;
  private stripActionLines: boolean;

  constructor(
    storage: SqliteStorage,
    options: { maxMessages?: number; ttlDays?: number; stripActionLines?: boolean } = {}
  ) {
    this.db = storage.db;
    this.maxMessages = options.maxMessages ?? 100;
    this.ttlDays = options.ttlDays ?? 14;
    this.stripActionLines = options.stripActionLines ?? false;
  }

  /** Add a message to conversation history */
  add(chatId: string, role: 'user' | 'assistant', content: string, metadata?: Record<string, unknown>): void {
    let processedContent = content;
    if (this.stripActionLines && role === 'assistant') {
      processedContent = content
        .split('\n')
        .filter(line => !line.startsWith('ACTION:'))
        .join('\n')
        .trim();
    }

    this.db.prepare(`
      INSERT INTO conversation_history (chat_id, role, content, metadata)
      VALUES (?, ?, ?, ?)
    `).run(chatId, role, processedContent, metadata ? JSON.stringify(metadata) : null);
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
    const messages = this.getRecent(chatId).reverse();
    if (messages.length === 0) return '';

    const lines = messages.map(m =>
      `[${m.created_at}] ${m.role}: ${m.content}`
    );

    return `<recent_conversation_history>\n${lines.join('\n')}\n</recent_conversation_history>`;
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
}
