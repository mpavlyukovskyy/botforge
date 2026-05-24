/**
 * @botforge/skill-dlq — unified dead-letter queue.
 *
 * Five bots have bespoke dlq-like tables (Kristina sync_failures, Maia
 * dead_letter, Harry sync_retry_state, Atlas failed_syncs, Babushka
 * whisper_errors). This skill replaces them with a single schema bot
 * authors can write to via ctx.skills.get('dlq').add(kind, payload, error).
 *
 * Operations:
 *   add(kind, payload, error)        — record a failure (returns row id)
 *   listPending(kind?)               — fetch rows still needing attention
 *   markReplayed(id)                 — operator/admin processed it
 *   markDead(id)                     — give up; alert
 *   pendingCount()                   — for daily digest / health
 *   prune(olderThanDays)             — sweep old 'dead' rows
 *
 * Per-bot SQLite (data/<botName>-dlq.db) so a corrupt DLQ can't take
 * conversation history with it. Migrations via DLQ_MIGRATIONS.
 */

import type { Skill, SkillContext } from '@botforge/core';
import { SqliteStorage, DLQ_MIGRATIONS } from '@botforge/storage-sqlite';

export type DlqStatus = 'pending' | 'replayed' | 'dead';

export interface DlqRow {
  id: number;
  kind: string;
  payload: string;
  error: string;
  occurred_at: string;
  attempts: number;
  status: DlqStatus;
  replayed_at: string | null;
}

export class DlqSkill implements Skill {
  readonly name = 'dlq';
  private storage?: SqliteStorage;

  async init(ctx: SkillContext): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dlqCfg = (ctx.config as any).dlq;
    if (dlqCfg?.enabled === false) {
      ctx.log.warn('dlq: disabled via config (dlq.enabled: false)');
      return;
    }
    this.storage = new SqliteStorage({
      path: `data/${ctx.config.name}-dlq.db`,
      migrations: DLQ_MIGRATIONS,
      log: ctx.log,
    });
    ctx.log.info('dlq: ready');
  }

  async destroy(): Promise<void> {
    this.storage?.close();
  }

  /** Record a failure. Returns the new row id. */
  add(kind: string, payload: unknown, error: unknown): number | undefined {
    if (!this.storage) return undefined;
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const errorStr = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const res = this.storage.db.prepare(
      `INSERT INTO dlq (kind, payload, error) VALUES (?, ?, ?)`,
    ).run(kind, payloadStr.slice(0, 100_000), errorStr.slice(0, 5000));
    return Number(res.lastInsertRowid);
  }

  /** List rows still requiring attention (status='pending'), optionally filtered by kind. */
  listPending(kind?: string, limit = 100): DlqRow[] {
    if (!this.storage) return [];
    if (kind) {
      return this.storage.db.prepare(
        `SELECT * FROM dlq WHERE status='pending' AND kind=? ORDER BY occurred_at DESC LIMIT ?`,
      ).all(kind, limit) as DlqRow[];
    }
    return this.storage.db.prepare(
      `SELECT * FROM dlq WHERE status='pending' ORDER BY occurred_at DESC LIMIT ?`,
    ).all(limit) as DlqRow[];
  }

  /** Mark a row as successfully replayed. */
  markReplayed(id: number): void {
    if (!this.storage) return;
    this.storage.db.prepare(
      `UPDATE dlq SET status='replayed', replayed_at=datetime('now') WHERE id=?`,
    ).run(id);
  }

  /** Mark a row as dead (no further retries). */
  markDead(id: number): void {
    if (!this.storage) return;
    this.storage.db.prepare(`UPDATE dlq SET status='dead' WHERE id=?`).run(id);
  }

  /** Total count of pending rows (for daily-digest + health alerts). */
  pendingCount(): number {
    if (!this.storage) return 0;
    const row = this.storage.db.prepare(
      `SELECT COUNT(*) as n FROM dlq WHERE status='pending'`,
    ).get() as { n: number };
    return row.n;
  }

  /** Prune old 'dead' rows. */
  prune(olderThanDays = 30): number {
    if (!this.storage) return 0;
    const res = this.storage.db.prepare(
      `DELETE FROM dlq WHERE status='dead' AND datetime(occurred_at) < datetime('now', ?)`,
    ).run(`-${olderThanDays} days`);
    return res.changes;
  }
}

export function createSkill(): DlqSkill {
  return new DlqSkill();
}

export default new DlqSkill();
