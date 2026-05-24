/**
 * @botforge/skill-telegram-outbox — durable outbound delivery.
 *
 * Today's pattern: `await adapter.send(...)` direct from a handler. A crash
 * between the handler deciding what to send and Telegram receiving it is a
 * silent message loss (analogous to the inbound bug T1.2 fixed).
 *
 * Outbox pattern: handlers enqueue payloads to SQLite synchronously. A
 * background worker drains the queue, calling adapter.send. Retry with
 * exponential backoff on transient errors; on max attempts -> DLQ.
 *
 * Usage:
 *   const outbox = ctx.skills.get('telegram-outbox');
 *   const id = outbox.enqueue({ chatId, text: 'hi' });
 *
 * Worker:
 *   - Polls every 250ms by default (configurable via outbox.poll_interval_ms)
 *   - Backoff schedule: 1s -> 5s -> 30s -> 5min, then mark failed -> DLQ
 *   - Honors outbox.enabled: false for kill-switch
 */

import type { Skill, SkillContext, Logger } from '@botforge/core';
import { SqliteStorage, TELEGRAM_OUTBOX_MIGRATIONS } from '@botforge/storage-sqlite';
import type { OutgoingMessage, PlatformAdapter } from '@botforge/core';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_BACKOFFS_MS = [1_000, 5_000, 30_000, 300_000];

export type OutboxStatus = 'pending' | 'sent' | 'failed';

export interface OutboxRow {
  id: number;
  chat_id: string;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string | null;
  sent_at: string | null;
}

export class TelegramOutboxSkill implements Skill {
  readonly name = 'telegram-outbox';
  private storage?: SqliteStorage;
  private workerTimer?: NodeJS.Timeout;
  private adapter?: PlatformAdapter;
  private log?: Logger;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private backoffs = DEFAULT_BACKOFFS_MS;
  private dlq?: { add: (kind: string, payload: unknown, error: unknown) => number | undefined };
  private draining = false;
  private stopped = false;

  async init(ctx: SkillContext): Promise<void> {
    if (ctx.config.platform.type !== 'telegram') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outboxCfg = (ctx.config as any).outbox;
    if (outboxCfg?.enabled === false) {
      ctx.log.warn('telegram-outbox: disabled via config');
      return;
    }
    if (typeof outboxCfg?.poll_interval_ms === 'number') {
      this.pollIntervalMs = outboxCfg.poll_interval_ms;
    }
    this.storage = new SqliteStorage({
      path: `data/${ctx.config.name}-outbox.db`,
      migrations: TELEGRAM_OUTBOX_MIGRATIONS,
      log: ctx.log,
    });
    this.adapter = ctx.adapter;
    this.log = ctx.log;

    // Hook up DLQ via skills map if available.
    const dlqSkill = ctx.skills.get('dlq');
    if (dlqSkill && 'add' in dlqSkill) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.dlq = dlqSkill as any;
    }

    // Start the worker loop.
    this.workerTimer = setInterval(() => {
      this.drain().catch((err) => ctx.log.error(`outbox worker error: ${err}`));
    }, this.pollIntervalMs);
    this.workerTimer.unref?.();

    ctx.log.info(`telegram-outbox: enabled (poll ${this.pollIntervalMs}ms, ${this.backoffs.length}-step backoff)`);
  }

  async destroy(): Promise<void> {
    this.stopped = true;
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.storage?.close();
  }

  /**
   * Persist a message to be sent in the background. Returns the row id so
   * callers can check status later. Synchronous DB write — no await needed
   * for durability.
   */
  enqueue(message: OutgoingMessage): number | undefined {
    if (!this.storage) return undefined;
    const res = this.storage.db.prepare(
      `INSERT INTO tg_outbox (chat_id, payload_json) VALUES (?, ?)`,
    ).run(message.chatId, JSON.stringify(message));
    return Number(res.lastInsertRowid);
  }

  /** Manually drain the outbox once (used by tests). */
  async drain(): Promise<void> {
    if (!this.storage || !this.adapter || this.draining || this.stopped) return;
    this.draining = true;
    try {
      const row = this.nextDue();
      if (!row) return;
      try {
        const payload = JSON.parse(row.payload_json) as OutgoingMessage;
        await this.adapter.send(payload);
        this.markSent(row.id);
      } catch (err) {
        this.handleSendError(row, err);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Total count of pending rows (for daily-digest + health). */
  pendingCount(): number {
    if (!this.storage) return 0;
    const row = this.storage.db.prepare(
      `SELECT COUNT(*) as n FROM tg_outbox WHERE status='pending'`,
    ).get() as { n: number };
    return row.n;
  }

  /** Status counts for observability. */
  stats(): Record<OutboxStatus, number> {
    if (!this.storage) return { pending: 0, sent: 0, failed: 0 };
    const rows = this.storage.db.prepare(
      `SELECT status, COUNT(*) as n FROM tg_outbox GROUP BY status`,
    ).all() as Array<{ status: OutboxStatus; n: number }>;
    const out: Record<OutboxStatus, number> = { pending: 0, sent: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Prune old 'sent' rows. */
  pruneSent(olderThanDays = 7): number {
    if (!this.storage) return 0;
    const res = this.storage.db.prepare(
      `DELETE FROM tg_outbox WHERE status='sent' AND datetime(sent_at) < datetime('now', ?)`,
    ).run(`-${olderThanDays} days`);
    return res.changes;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private nextDue(): OutboxRow | undefined {
    if (!this.storage) return undefined;
    return this.storage.db.prepare(
      `SELECT * FROM tg_outbox
       WHERE status='pending'
         AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
       ORDER BY id
       LIMIT 1`,
    ).get() as OutboxRow | undefined;
  }

  private markSent(id: number): void {
    this.storage!.db.prepare(
      `UPDATE tg_outbox SET status='sent', sent_at=datetime('now') WHERE id=?`,
    ).run(id);
  }

  private handleSendError(row: OutboxRow, err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    const attempts = row.attempts + 1;
    if (attempts >= this.backoffs.length + 1) {
      // Exhausted backoffs — mark failed + push to DLQ.
      this.storage!.db.prepare(
        `UPDATE tg_outbox SET status='failed', attempts=?, last_error=? WHERE id=?`,
      ).run(attempts, errMsg.slice(0, 1000), row.id);
      this.log?.error(`outbox: row ${row.id} exhausted retries — DLQ`);
      this.dlq?.add('telegram-outbox', JSON.parse(row.payload_json), err);
      return;
    }
    const backoffMs = this.backoffs[attempts - 1] ?? this.backoffs[this.backoffs.length - 1]!;
    const nextAt = new Date(Date.now() + backoffMs).toISOString();
    this.storage!.db.prepare(
      `UPDATE tg_outbox
       SET attempts=?, last_error=?, next_attempt_at=?
       WHERE id=?`,
    ).run(attempts, errMsg.slice(0, 1000), nextAt, row.id);
    this.log?.warn(`outbox: row ${row.id} attempt ${attempts} failed; retry in ${backoffMs}ms`);
  }
}

export function createSkill(): TelegramOutboxSkill {
  return new TelegramOutboxSkill();
}

export default new TelegramOutboxSkill();
