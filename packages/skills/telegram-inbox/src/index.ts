/**
 * @botforge/skill-telegram-inbox — durable at-least-once Telegram delivery.
 *
 * Backports the pattern from the standalone taskbot inbox (which fixed
 * Sara's lost-message bug) into the botforge framework. Every bot using
 * the TelegramAdapter inherits the fix by loading this skill.
 *
 * On init:
 *   1. Opens its own SQLite DB at data/<botName>-inbox.db (separate from
 *      conversation-history so a schema or corruption issue here can't
 *      affect history).
 *   2. Runs TELEGRAM_INBOX_MIGRATIONS to create the tg_inbox table.
 *   3. resetOrphanedOnBoot() — flips any 'processing' rows back to
 *      'received' so a crash-mid-handler restart re-runs them.
 *   4. adapter.setInbox(this) — wires the inbox into the adapter's
 *      processUpdate interceptor.
 *   5. Starts a periodic reaper (default 30s) that moves rows stuck in
 *      'processing' for >30s back to 'received' so a zombied handler
 *      doesn't block subsequent updates from the same chat.
 */

import type { Skill, SkillContext } from '@botforge/core';
import { SqliteStorage, TELEGRAM_INBOX_MIGRATIONS } from '@botforge/storage-sqlite';

import type Database from 'better-sqlite3';

export type InboxStatus = 'received' | 'processing' | 'done' | 'failed';

export interface InboxRow {
  update_id: number;
  kind: string;
  chat_id: string | null;
  raw_json: string;
  status: InboxStatus;
  attempts: number;
  received_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
}

export type AcquireResult =
  | { action: 'process'; row: InboxRow }
  | { action: 'skip'; reason: 'already_done' }
  | { action: 'skip'; reason: 'concurrent_worker' };

/** Default time after which a 'processing' row is reaped back to 'received'. */
const DEFAULT_PROCESSING_TIMEOUT_MS = 30_000;

/** Default reaper interval. */
const DEFAULT_REAPER_INTERVAL_MS = 30_000;

/** Max attempts before nextPending skips a row (avoids retry storms). */
const MAX_ATTEMPTS = 5;

export class TelegramInboxSkill implements Skill {
  readonly name = 'telegram-inbox';
  private storage?: SqliteStorage;
  private reaperTimer?: NodeJS.Timeout;
  private processingTimeoutMs = DEFAULT_PROCESSING_TIMEOUT_MS;
  private reaperIntervalMs = DEFAULT_REAPER_INTERVAL_MS;

  async init(ctx: SkillContext): Promise<void> {
    // Only wire up for Telegram platform.
    if (ctx.config.platform.type !== 'telegram') {
      ctx.log.debug('telegram-inbox: skipping — platform is not telegram');
      return;
    }
    // Opt-out via inbox.enabled: false (default ON).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inboxCfg = (ctx.config as any).inbox;
    if (inboxCfg?.enabled === false) {
      ctx.log.warn('telegram-inbox: disabled via config (inbox.enabled: false)');
      return;
    }
    if (typeof inboxCfg?.processing_timeout_ms === 'number') {
      this.processingTimeoutMs = inboxCfg.processing_timeout_ms;
    }

    // Open dedicated inbox DB to keep the schema independent of conv-history.
    this.storage = new SqliteStorage({
      path: `data/${ctx.config.name}-inbox.db`,
      migrations: TELEGRAM_INBOX_MIGRATIONS,
      log: ctx.log,
    });

    const moved = this.resetOrphanedOnBoot();
    if (moved > 0) {
      ctx.log.info(`telegram-inbox: reset ${moved} orphaned 'processing' rows for replay`);
    }

    // Wire into adapter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = ctx.adapter as any;
    if (typeof adapter.setInbox !== 'function') {
      ctx.log.warn('telegram-inbox: adapter does not expose setInbox(); inbox disabled');
      return;
    }
    adapter.setInbox(this);

    // Periodic reaper: move stuck 'processing' rows back to 'received'.
    this.reaperTimer = setInterval(() => {
      try {
        const reaped = this.reapStuck();
        if (reaped > 0) ctx.log.warn(`telegram-inbox: reaped ${reaped} stuck rows`);
      } catch (err) {
        ctx.log.error(`telegram-inbox reaper error: ${err}`);
      }
    }, this.reaperIntervalMs);
    // Don't block process exit on the timer.
    this.reaperTimer.unref?.();

    ctx.log.info(`telegram-inbox: enabled (timeout ${this.processingTimeoutMs}ms, reaper ${this.reaperIntervalMs}ms)`);
  }

  async destroy(): Promise<void> {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.storage?.close();
  }

  // ─── Public API used by TelegramAdapter ──────────────────────────────────

  acquireForProcessing(
    updateId: number,
    kind: string,
    chatId: string | null,
    rawJson: string,
  ): AcquireResult {
    if (!this.storage) return { action: 'process', row: this.fakeRow(updateId, kind, chatId, rawJson) };
    const db = this.storage.db;
    return db.transaction((): AcquireResult => {
      db.prepare(
        `INSERT OR IGNORE INTO tg_inbox (update_id, kind, chat_id, raw_json) VALUES (?, ?, ?, ?)`,
      ).run(updateId, kind, chatId, rawJson);

      const row = db.prepare(`SELECT * FROM tg_inbox WHERE update_id = ?`).get(updateId) as InboxRow;
      if (row.status === 'done') {
        return { action: 'skip', reason: 'already_done' };
      }
      if (row.status === 'processing') {
        return { action: 'skip', reason: 'concurrent_worker' };
      }
      const updated = db.prepare(
        `UPDATE tg_inbox
         SET status = 'processing',
             attempts = attempts + 1,
             started_at = datetime('now'),
             last_error = NULL
         WHERE update_id = ? AND status IN ('received','failed')
         RETURNING *`,
      ).get(updateId) as InboxRow | undefined;
      if (!updated) {
        return { action: 'skip', reason: 'concurrent_worker' };
      }
      return { action: 'process', row: updated };
    })();
  }

  markDone(updateId: number): void {
    if (!this.storage) return;
    this.storage.db.prepare(
      `UPDATE tg_inbox SET status = 'done', finished_at = datetime('now') WHERE update_id = ?`,
    ).run(updateId);
  }

  markFailed(updateId: number, error: string): void {
    if (!this.storage) return;
    this.storage.db.prepare(
      `UPDATE tg_inbox SET status = 'failed', finished_at = datetime('now'), last_error = ? WHERE update_id = ?`,
    ).run(error.slice(0, 1000), updateId);
  }

  // ─── Lifecycle + stats ────────────────────────────────────────────────────

  /** On boot: flip any leftover 'processing' rows back to 'received'. */
  resetOrphanedOnBoot(): number {
    if (!this.storage) return 0;
    const res = this.storage.db.prepare(
      `UPDATE tg_inbox SET status = 'received', started_at = NULL WHERE status = 'processing'`,
    ).run();
    return res.changes;
  }

  /** Reap rows stuck in 'processing' for longer than processing_timeout_ms. */
  reapStuck(): number {
    if (!this.storage) return 0;
    // julianday() is the fractional-day representation SQLite uses internally.
    // Using it on both sides lets sub-second timeouts work; datetime() rounds
    // to seconds and makes 100ms timeouts a no-op.
    const cutoffSeconds = this.processingTimeoutMs / 1000;
    const res = this.storage.db.prepare(
      `UPDATE tg_inbox
       SET status = 'received', started_at = NULL
       WHERE status = 'processing'
         AND started_at IS NOT NULL
         AND julianday(started_at) < julianday('now', ?)`,
    ).run(`-${cutoffSeconds} seconds`);
    return res.changes;
  }

  /** Pull the oldest pending row for the boot-time drain worker. */
  nextPending(): InboxRow | undefined {
    if (!this.storage) return undefined;
    return this.storage.db.prepare(
      `SELECT * FROM tg_inbox
       WHERE status IN ('received','failed')
         AND attempts < ?
       ORDER BY update_id
       LIMIT 1`,
    ).get(MAX_ATTEMPTS) as InboxRow | undefined;
  }

  inboxStats(): Record<string, number> {
    if (!this.storage) return { received: 0, processing: 0, done: 0, failed: 0 };
    const rows = this.storage.db.prepare(
      `SELECT status, COUNT(*) as n FROM tg_inbox GROUP BY status`,
    ).all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = { received: 0, processing: 0, done: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Periodic prune of old 'done' rows. */
  pruneDone(olderThanDays: number = 30): number {
    if (!this.storage) return 0;
    const res = this.storage.db.prepare(
      `DELETE FROM tg_inbox WHERE status = 'done' AND datetime(finished_at) < datetime('now', ?)`,
    ).run(`-${olderThanDays} days`);
    return res.changes;
  }

  /** Direct DB access for tests. */
  get db(): Database.Database | undefined {
    return this.storage?.db;
  }

  private fakeRow(updateId: number, kind: string, chatId: string | null, rawJson: string): InboxRow {
    return {
      update_id: updateId,
      kind,
      chat_id: chatId,
      raw_json: rawJson,
      status: 'processing',
      attempts: 1,
      received_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      last_error: null,
    };
  }
}

export function createSkill(): TelegramInboxSkill {
  return new TelegramInboxSkill();
}

export default new TelegramInboxSkill();
