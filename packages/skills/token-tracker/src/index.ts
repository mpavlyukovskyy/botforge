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
  {
    // Adds bot_name to token_usage and changes PK to (date, model, bot_name).
    // SQLite can't ALTER a primary key in place, so we recreate the table.
    // Source SELECT lists only the v100 columns; the new table's bot_name DEFAULT
    // 'unknown' fills in for legacy rows. Wrapped in a tx by the migration runner.
    // Already applied in prod (Kristina at 2026-05-10) — this version's body matches
    // what was deployed at the time, so the _migrations row remains canonical.
    version: 101,
    name: 'add_bot_name_to_token_usage',
    up: `
      CREATE TABLE __token_usage_new (
        date TEXT NOT NULL,
        model TEXT NOT NULL,
        bot_name TEXT NOT NULL DEFAULT 'unknown',
        call_count INTEGER NOT NULL DEFAULT 0,
        cost_cents REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, model, bot_name)
      );
      INSERT INTO __token_usage_new (date, model, call_count, cost_cents)
        SELECT date, model, call_count, cost_cents FROM token_usage;
      DROP TABLE token_usage;
      ALTER TABLE __token_usage_new RENAME TO token_usage;
    `,
  },
];

export class TokenTrackerSkill implements Skill {
  readonly name = 'token-tracker';
  private storage?: SqliteStorage;
  private botName = 'unknown';

  async init(ctx: SkillContext): Promise<void> {
    const dbPath = `data/${ctx.config.name}.db`;
    this.botName = ctx.config.name;
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
      INSERT INTO token_usage (date, model, bot_name, call_count, cost_cents)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(date, model, bot_name) DO UPDATE SET
        call_count = call_count + 1,
        cost_cents = cost_cents + excluded.cost_cents
    `).run(date, model, this.botName, costCents);
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

  /**
   * Total USD spent for a given date (default: today). Used by the
   * brain-processor budget gate to decide whether to refuse a call.
   */
  getDailySpend(date?: string): number {
    if (!this.storage) return 0;
    const d = date ?? new Date().toISOString().split('T')[0];
    const row = this.storage.db.prepare(`
      SELECT SUM(cost_cents) as total
      FROM token_usage
      WHERE date = ?
    `).get(d) as { total: number | null } | undefined;
    return (row?.total ?? 0) / 100;
  }

  async destroy(): Promise<void> {
    this.storage?.close();
  }
}

export function createSkill(): TokenTrackerSkill {
  return new TokenTrackerSkill();
}

export default new TokenTrackerSkill();
