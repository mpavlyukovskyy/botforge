import type { Skill, SkillContext } from '@botforge/core';
import { SqliteStorage, type Migration } from '@botforge/storage-sqlite';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InteractionEntry {
  id: string;
  botName: string;
  chatId: string;
  userId: string;
  provider: string;
  model?: string;
  systemPromptLength?: number;
  contextBlockTags?: string[];
  userMessage: string;
  toolCalls?: ToolCallEntry[];
  brainTurns?: number;
  latencyMs?: number;
  responseText?: string;
  responseLength?: number;
  costUsd?: number | null;
  status: 'success' | 'error' | 'timeout';
  errorMessage?: string | null;
  /** Categorical error tag (atlas_timeout, rate_limited, usage_limit, etc.) */
  errorClass?: string | null;
}

export interface ToolCallEntry {
  name: string;
  args?: string;
  resultLength?: number;
  durationMs?: number;
  error?: boolean;
  errorMessage?: string;
}

export interface InteractionRow {
  id: string;
  bot_name: string;
  chat_id: string;
  user_id: string;
  timestamp: string;
  provider: string;
  model: string | null;
  system_prompt_length: number | null;
  context_block_tags: string | null;
  user_message: string;
  tool_calls: string | null;
  brain_turns: number | null;
  latency_ms: number | null;
  response_text: string | null;
  response_length: number | null;
  cost_usd: number | null;
  status: string;
  error_message: string | null;
  error_class: string | null;
}

export interface StatsResult {
  count: number;
  avg_latency_ms: number | null;
  total_cost_usd: number | null;
  error_count: number;
}

// ─── Migrations ─────────────────────────────────────────────────────────────

const INTERACTION_LOG_MIGRATIONS: Migration[] = [
  {
    version: 100,
    name: 'create_interaction_log',
    up: `
      CREATE TABLE IF NOT EXISTS interaction_log (
        id TEXT PRIMARY KEY,
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        provider TEXT NOT NULL,
        model TEXT,
        system_prompt_length INTEGER,
        context_block_tags TEXT,
        user_message TEXT NOT NULL,
        tool_calls TEXT,
        brain_turns INTEGER,
        latency_ms INTEGER,
        response_text TEXT,
        response_length INTEGER,
        cost_usd REAL,
        status TEXT NOT NULL DEFAULT 'success',
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ilog_bot_ts ON interaction_log(bot_name, timestamp);
      CREATE INDEX IF NOT EXISTS idx_ilog_chat ON interaction_log(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_ilog_status ON interaction_log(status, timestamp);
    `,
  },
  {
    version: 101,
    name: 'add_error_class_column',
    // SQLite ALTER TABLE ADD COLUMN is non-destructive and only runs once per
    // schema version. We don't need IF NOT EXISTS — the migration framework
    // tracks applied versions.
    up: `
      ALTER TABLE interaction_log ADD COLUMN error_class TEXT;
      CREATE INDEX IF NOT EXISTS idx_ilog_error_class ON interaction_log(error_class, timestamp);
    `,
  },
];

// ─── Skill ──────────────────────────────────────────────────────────────────

export class InteractionLogSkill implements Skill {
  readonly name = 'interaction-log';
  private storage?: SqliteStorage;
  private ttlDays: number;

  constructor(ttlDays = 30) {
    this.ttlDays = ttlDays;
  }

  async init(ctx: SkillContext): Promise<void> {
    const dbPath = `data/${ctx.config.name}-interactions.db`;
    this.storage = new SqliteStorage({
      path: dbPath,
      migrations: INTERACTION_LOG_MIGRATIONS,
      log: ctx.log,
    });

    // Run cleanup on init
    const deleted = this.cleanup();
    if (deleted > 0) {
      ctx.log.info(`Interaction log cleanup: removed ${deleted} rows older than ${this.ttlDays} days`);
    }

    ctx.log.info('Interaction log initialized');
  }

  /** Record an interaction */
  record(entry: InteractionEntry): void {
    if (!this.storage) return;

    this.storage.db.prepare(`
      INSERT INTO interaction_log (
        id, bot_name, chat_id, user_id, provider, model,
        system_prompt_length, context_block_tags,
        user_message, tool_calls, brain_turns, latency_ms,
        response_text, response_length, cost_usd,
        status, error_message, error_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.botName,
      entry.chatId,
      entry.userId,
      entry.provider,
      entry.model ?? null,
      entry.systemPromptLength ?? null,
      entry.contextBlockTags ? JSON.stringify(entry.contextBlockTags) : null,
      entry.userMessage.slice(0, 2000),
      entry.toolCalls ? JSON.stringify(entry.toolCalls) : null,
      entry.brainTurns ?? null,
      entry.latencyMs ?? null,
      entry.responseText?.slice(0, 5000) ?? null,
      entry.responseLength ?? null,
      entry.costUsd ?? null,
      entry.status,
      entry.errorMessage ?? null,
      entry.errorClass ?? null,
    );
  }

  /** Get recent interactions, optionally filtered by bot name */
  getRecent(limit = 50, botName?: string): InteractionRow[] {
    if (!this.storage) return [];

    if (botName) {
      return this.storage.db.prepare(`
        SELECT * FROM interaction_log
        WHERE bot_name = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(botName, limit) as InteractionRow[];
    }

    return this.storage.db.prepare(`
      SELECT * FROM interaction_log
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as InteractionRow[];
  }

  /** Get a single interaction by ID */
  getById(id: string): InteractionRow | undefined {
    if (!this.storage) return undefined;

    return this.storage.db.prepare(`
      SELECT * FROM interaction_log WHERE id = ?
    `).get(id) as InteractionRow | undefined;
  }

  /** Get aggregate stats for the last N days */
  getStats(days = 7): StatsResult {
    if (!this.storage) {
      return { count: 0, avg_latency_ms: null, total_cost_usd: null, error_count: 0 };
    }

    const row = this.storage.db.prepare(`
      SELECT
        COUNT(*) as count,
        AVG(latency_ms) as avg_latency_ms,
        SUM(cost_usd) as total_cost_usd,
        COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) as error_count
      FROM interaction_log
      WHERE timestamp >= datetime('now', ?)
    `).get(`-${days} days`) as StatsResult;

    return row;
  }

  /** Delete rows older than specified days, returns count deleted */
  cleanup(days?: number): number {
    if (!this.storage) return 0;

    const ttl = days ?? this.ttlDays;
    const result = this.storage.db.prepare(`
      DELETE FROM interaction_log
      WHERE timestamp < datetime('now', ?)
    `).run(`-${ttl} days`);

    return result.changes;
  }

  async destroy(): Promise<void> {
    this.storage?.close();
  }
}

export function createSkill(): InteractionLogSkill {
  return new InteractionLogSkill();
}

export default new InteractionLogSkill();
