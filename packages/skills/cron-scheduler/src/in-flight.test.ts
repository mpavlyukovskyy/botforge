import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { CronSchedulerSkill } from './index.js';
import type { BotConfig } from '@botforge/core/schema';
import type { SkillContext, DatabaseLike, Logger } from '@botforge/core';

interface WrappedDb extends DatabaseLike {
  raw: Database.Database;
}

function makeDb(): WrappedDb {
  const db = new Database(':memory:');
  return {
    raw: db,
    run: (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params),
    prepare: (sql: string) => db.prepare(sql),
    close: () => db.close(),
  };
}

function silentLog(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function makeConfig(overrides: Partial<BotConfig['schedule']> = {}): BotConfig {
  return {
    name: 'Test',
    version: '1.0',
    platform: { type: 'telegram', token: 't', mode: 'polling' } as any,
    brain: { provider: 'claude', model: 'claude-haiku-4-5-20251001', tools: [], system_prompt: 'x' } as any,
    schedule: {
      morning_job: { cron: '0 7 * * *', timezone: 'UTC', replay_on_crash: true } as any,
      digest_job: { cron: '0 9 * * *', timezone: 'UTC', replay_on_crash: false } as any,
      ...overrides,
    },
  } as BotConfig;
}

function makeCtx(db: WrappedDb, config: BotConfig): SkillContext {
  return {
    config,
    adapter: {} as any,
    log: silentLog(),
    db,
    skills: new Map(),
    store: new Map(),
  };
}

let db: WrappedDb;
let skill: CronSchedulerSkill;

beforeEach(() => {
  db = makeDb();
  skill = new CronSchedulerSkill();
});

afterEach(async () => {
  // Tear down scheduled cron tasks so the test process exits cleanly.
  await skill.destroy();
  db.close();
});

describe('cron_runs schema migration', () => {
  it('creates the table on init if it does not exist', async () => {
    await skill.init(makeCtx(db, makeConfig()));
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_runs'").all() as Array<{ name: string }>;
    assert.equal(tables.length, 1);
  });

  it('is idempotent — running migration twice is a no-op', async () => {
    await skill.init(makeCtx(db, makeConfig()));
    await skill.init(makeCtx(db, makeConfig()));
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_runs'").all();
    assert.equal(tables.length, 1);
  });
});

describe('in_flight CAS guard', () => {
  it('concurrent acquire on already-in-flight row is rejected (CAS guard)', async () => {
    await skill.init(makeCtx(db, makeConfig()));
    // Pre-seed in_flight=1
    db.run('INSERT INTO cron_runs (job_name, in_flight) VALUES (?, 1)', 'morning_job');
    // Attempt another acquire — should fail (0 changes).
    const result = db.run(
      `INSERT INTO cron_runs (job_name, in_flight, last_attempt_run)
       VALUES (?, 1, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         in_flight = 1,
         last_attempt_run = excluded.last_attempt_run
       WHERE in_flight = 0`,
      'morning_job', Date.now(),
    ) as { changes?: number };
    assert.equal(result.changes ?? 0, 0, 'CAS should not flip 1→1 when in_flight=1');
  });

  it('first acquire on a fresh job inserts row with in_flight=1', () => {
    db.run(`CREATE TABLE cron_runs (job_name TEXT PRIMARY KEY, in_flight INTEGER NOT NULL DEFAULT 0, last_successful_run INTEGER, last_attempt_run INTEGER)`);
    const result = db.run(
      `INSERT INTO cron_runs (job_name, in_flight, last_attempt_run)
       VALUES (?, 1, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         in_flight = 1,
         last_attempt_run = excluded.last_attempt_run
       WHERE in_flight = 0`,
      'fresh_job', 1000,
    ) as { changes?: number };
    assert.equal(result.changes, 1);
    const row = db.raw.prepare('SELECT * FROM cron_runs WHERE job_name=?').get('fresh_job') as { in_flight: number; last_attempt_run: number };
    assert.equal(row.in_flight, 1);
    assert.equal(row.last_attempt_run, 1000);
  });
});

describe('replay_on_crash behavior', () => {
  it('init clears stale in_flight rows for replay_on_crash=false jobs (no replay)', async () => {
    // Pre-seed: digest_job (replay_on_crash=false) was in_flight at last shutdown
    db.run(`CREATE TABLE cron_runs (job_name TEXT PRIMARY KEY, in_flight INTEGER NOT NULL DEFAULT 0, last_successful_run INTEGER, last_attempt_run INTEGER)`);
    db.run('INSERT INTO cron_runs (job_name, in_flight) VALUES (?, 1)', 'digest_job');

    let invoked = 0;
    skill.registerHandler('digest_job', async () => { invoked++; });

    await skill.init(makeCtx(db, makeConfig()));
    await skill.runDeferredReplays();

    assert.equal(invoked, 0, 'handler must NOT be replayed when replay_on_crash=false');
    const row = db.raw.prepare('SELECT in_flight FROM cron_runs WHERE job_name=?').get('digest_job') as { in_flight: number };
    assert.equal(row.in_flight, 0, 'in_flight should be cleared');
  });

  it('init collects + replays in_flight rows for replay_on_crash=true jobs', async () => {
    db.run(`CREATE TABLE cron_runs (job_name TEXT PRIMARY KEY, in_flight INTEGER NOT NULL DEFAULT 0, last_successful_run INTEGER, last_attempt_run INTEGER)`);
    db.run('INSERT INTO cron_runs (job_name, in_flight) VALUES (?, 1)', 'morning_job');

    let invoked = 0;
    skill.registerHandler('morning_job', async () => { invoked++; });

    await skill.init(makeCtx(db, makeConfig()));
    // BEFORE runDeferredReplays — must NOT replay yet
    assert.equal(invoked, 0, 'replay must be deferred — not triggered during init()');

    await skill.runDeferredReplays();
    assert.equal(invoked, 1, 'replay triggered AFTER runDeferredReplays()');
    const row = db.raw.prepare('SELECT in_flight, last_successful_run FROM cron_runs WHERE job_name=?').get('morning_job') as { in_flight: number; last_successful_run: number };
    assert.equal(row.in_flight, 0, 'in_flight cleared after successful replay');
    assert.ok(row.last_successful_run > 0, 'last_successful_run stamped');
  });

  it('init drops in_flight flag for unknown jobs (no handler registered)', async () => {
    db.run(`CREATE TABLE cron_runs (job_name TEXT PRIMARY KEY, in_flight INTEGER NOT NULL DEFAULT 0, last_successful_run INTEGER, last_attempt_run INTEGER)`);
    db.run('INSERT INTO cron_runs (job_name, in_flight) VALUES (?, 1)', 'morning_job');
    // No handler registered for morning_job

    await skill.init(makeCtx(db, makeConfig()));

    const row = db.raw.prepare('SELECT in_flight FROM cron_runs WHERE job_name=?').get('morning_job') as { in_flight: number };
    assert.equal(row.in_flight, 0, 'orphaned in_flight flag must be cleared');
  });
});
