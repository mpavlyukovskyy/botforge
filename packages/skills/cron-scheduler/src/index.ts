import type { Skill, SkillContext } from '@botforge/core';
import cron from 'node-cron';

export type CronHandler = () => Promise<void>;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cron_runs (
    job_name TEXT PRIMARY KEY,
    in_flight INTEGER NOT NULL DEFAULT 0,
    last_successful_run INTEGER,
    last_attempt_run INTEGER
  );
`;

/**
 * Atomic compare-and-swap. Returns true if the row was successfully marked
 * in_flight=1 (the caller should proceed to run the handler), false if the
 * row was already in_flight (another handler invocation is in progress —
 * skip this fire to avoid double-execution).
 */
function acquireRun(db: SkillContext['db'], jobName: string, now: number): boolean {
  if (!db) return true; // no DB → no tracking → always proceed (legacy behavior)
  const upsertSql = `
    INSERT INTO cron_runs (job_name, in_flight, last_attempt_run)
    VALUES (?, 1, ?)
    ON CONFLICT(job_name) DO UPDATE SET
      in_flight = 1,
      last_attempt_run = excluded.last_attempt_run
    WHERE in_flight = 0
  `;
  // better-sqlite3's run() returns { changes: number }. Other DatabaseLike
  // backings may differ — assume the same shape.
  const result = db.run(upsertSql, jobName, now) as { changes?: number } | undefined;
  return (result?.changes ?? 1) > 0;
}

function releaseRun(db: SkillContext['db'], jobName: string, success: boolean, now: number): void {
  if (!db) return;
  if (success) {
    db.run('UPDATE cron_runs SET in_flight=0, last_successful_run=? WHERE job_name=?', now, jobName);
  } else {
    db.run('UPDATE cron_runs SET in_flight=0 WHERE job_name=?', jobName);
  }
}

interface PendingReplay {
  jobName: string;
  handler: CronHandler;
  replay: boolean;
}

export class CronSchedulerSkill implements Skill {
  readonly name = 'cron-scheduler';
  private tasks: cron.ScheduledTask[] = [];
  private handlers = new Map<string, CronHandler>();
  private pendingReplays: PendingReplay[] = [];
  private db?: SkillContext['db'];
  private log?: SkillContext['log'];

  async init(ctx: SkillContext): Promise<void> {
    const schedule = ctx.config.schedule;
    if (!schedule) return;

    this.db = ctx.db;
    this.log = ctx.log;

    if (ctx.db) {
      ctx.db.run(SCHEMA_SQL);
      // Find jobs that were in_flight when the process died. Collect for
      // optional replay AFTER lifecycle 'start' hooks fire — runtime.ts calls
      // runDeferredReplays() at the right moment.
      const stmt = ctx.db.prepare('SELECT job_name FROM cron_runs WHERE in_flight=1') as {
        all: () => Array<{ job_name: string }>;
      };
      const orphans = stmt.all();
      for (const row of orphans) {
        const jobConfig = schedule[row.job_name];
        const handler = this.handlers.get(row.job_name);
        if (!handler || !jobConfig) {
          // Unknown job — clear the flag so it doesn't loop.
          ctx.db.run('UPDATE cron_runs SET in_flight=0 WHERE job_name=?', row.job_name);
          ctx.log.warn(`cron-scheduler: dropping in_flight flag for unknown job "${row.job_name}"`);
          continue;
        }
        const willReplay = jobConfig.replay_on_crash === true;
        if (!willReplay) {
          // Clear the flag immediately — operator opted out of replay.
          ctx.db.run('UPDATE cron_runs SET in_flight=0 WHERE job_name=?', row.job_name);
          ctx.log.warn(`cron-scheduler: job "${row.job_name}" was in-flight at last shutdown — NOT replaying (replay_on_crash=false)`);
        }
        this.pendingReplays.push({ jobName: row.job_name, handler, replay: willReplay });
      }
    }

    // Register cron jobs from config
    for (const [jobName, jobConfig] of Object.entries(schedule)) {
      const handler = this.handlers.get(jobName);
      if (!handler) {
        ctx.log.debug(`No handler registered for cron job "${jobName}", skipping`);
        continue;
      }

      if (!cron.validate(jobConfig.cron)) {
        ctx.log.warn(`Invalid cron expression for "${jobName}": ${jobConfig.cron}`);
        continue;
      }

      const task = cron.schedule(jobConfig.cron, async () => {
        await this.runHandler(jobName, handler);
      }, {
        timezone: jobConfig.timezone ?? 'UTC',
        scheduled: true,
      });

      this.tasks.push(task);
      ctx.log.info(`Scheduled cron job: ${jobName} (${jobConfig.cron} ${jobConfig.timezone ?? 'UTC'})`);
    }
  }

  /**
   * Invoked by runtime.ts AFTER lifecycle 'start' hooks fire. Replays any
   * jobs that were in_flight at last shutdown and opted into replay_on_crash.
   * Deferred (vs. running during init()) because handler code may rely on
   * lifecycle state that's only set up after start hooks complete.
   *
   * Bypasses the CAS guard since by definition the previous in_flight=1 row
   * is exactly what we're resuming.
   */
  async runDeferredReplays(): Promise<void> {
    for (const { jobName, handler, replay } of this.pendingReplays) {
      if (!replay) continue;
      this.log?.warn(`cron-scheduler: replaying "${jobName}" (was in_flight at last shutdown)`);
      // Clear in_flight then invoke — replay is THIS run, not a competing one.
      this.db?.run('UPDATE cron_runs SET in_flight=0 WHERE job_name=?', jobName);
      await this.runHandler(jobName, handler);
    }
    this.pendingReplays = [];
  }

  private async runHandler(jobName: string, handler: CronHandler): Promise<void> {
    const now = Date.now();
    if (!acquireRun(this.db, jobName, now)) {
      this.log?.warn(`cron-scheduler: "${jobName}" skipped (already in flight)`);
      return;
    }
    this.log?.info(`Running cron job: ${jobName}`);
    let success = false;
    try {
      await handler();
      success = true;
    } catch (err) {
      this.log?.error(`Cron job "${jobName}" failed: ${err}`);
    } finally {
      releaseRun(this.db, jobName, success, Date.now());
    }
  }

  /** Register a named handler that other skills can set up before init */
  registerHandler(name: string, handler: CronHandler): void {
    this.handlers.set(name, handler);
  }

  async destroy(): Promise<void> {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
  }
}

export function createSkill(): CronSchedulerSkill {
  return new CronSchedulerSkill();
}

export default new CronSchedulerSkill();
