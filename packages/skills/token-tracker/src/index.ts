import type { Skill, SkillContext } from '@botforge/core';
import { SqliteStorage, type Migration } from '@botforge/storage-sqlite';

const TOKEN_TRACKER_MIGRATIONS: Migration[] = [
  {
    version: 100,
    name: 'create_token_usage',
    up: `
      CREATE TABLE IF NOT EXISTS token_usage (
        date TEXT NOT NULL,
        model TEXT NOT NULL,
        call_count INTEGER NOT NULL DEFAULT 0,
        cost_cents REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, model)
      );
    `,
  },
];

export class TokenTrackerSkill implements Skill {
  readonly name = 'token-tracker';
  private storage?: SqliteStorage;

  async init(ctx: SkillContext): Promise<void> {
    const dbPath = `data/${ctx.config.name}.db`;
    this.storage = new SqliteStorage({
      path: dbPath,
      migrations: TOKEN_TRACKER_MIGRATIONS,
      log: ctx.log,
    });

    ctx.log.info('Token tracker initialized');
  }

  /** Record usage after an askBrain() call */
  async recordUsage(model: string, costUsd: number): Promise<void> {
    if (!this.storage) return;

    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const costCents = costUsd * 100;

    this.storage.db.prepare(`
      INSERT INTO token_usage (date, model, call_count, cost_cents)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(date, model) DO UPDATE SET
        call_count = call_count + 1,
        cost_cents = cost_cents + excluded.cost_cents
    `).run(date, model, costCents);
  }

  /** Get usage summary for health endpoint */
  getUsageSummary(days = 30): Array<{ date: string; model: string; call_count: number; cost_cents: number }> {
    if (!this.storage) return [];

    return this.storage.db.prepare(`
      SELECT date, model, call_count, cost_cents
      FROM token_usage
      WHERE date >= date('now', ?)
      ORDER BY date DESC, model
    `).all(`-${days} days`) as any[];
  }

  /** Get total cost for today */
  getTodayCost(): number {
    if (!this.storage) return 0;

    const row = this.storage.db.prepare(`
      SELECT SUM(cost_cents) as total
      FROM token_usage
      WHERE date = date('now')
    `).get() as { total: number | null } | undefined;

    return (row?.total ?? 0) / 100; // Return USD
  }

  async destroy(): Promise<void> {
    this.storage?.close();
  }
}

export function createSkill(): TokenTrackerSkill {
  return new TokenTrackerSkill();
}

export default new TokenTrackerSkill();
