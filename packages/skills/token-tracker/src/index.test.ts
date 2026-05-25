import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { TokenTrackerSkill } from './index.js';
import type { SkillContext, Logger } from '@botforge/core';

let tmpDir: string;
let skill: TokenTrackerSkill;

function silentLog(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx(name = 'TestBot'): SkillContext {
  process.chdir(tmpDir);
  return {
    config: {
      name,
      version: '1.0',
      platform: { type: 'telegram', token: 't', mode: 'polling' } as any,
      brain: { provider: 'claude', model: 'm', tools: [] } as any,
    } as any,
    adapter: {} as any,
    log: silentLog(),
    skills: new Map(),
    store: new Map(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tok-'));
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  skill = new TokenTrackerSkill();
});

afterEach(async () => {
  await skill.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('token-tracker — getDailySpend', () => {
  it('returns 0 for a fresh DB', async () => {
    await skill.init(makeCtx());
    assert.equal(skill.getDailySpend(), 0);
  });

  it('sums today\'s costs across models in USD', async () => {
    await skill.init(makeCtx());
    await skill.recordUsage('claude-opus-4-6', 0.25);
    await skill.recordUsage('claude-opus-4-6', 0.10);
    await skill.recordUsage('claude-sonnet-4-6', 0.05);
    assert.ok(Math.abs(skill.getDailySpend() - 0.40) < 0.0001, 'should be ~$0.40');
  });

  it('respects explicit date arg', async () => {
    await skill.init(makeCtx());
    await skill.recordUsage('claude-opus-4-6', 1.50);
    // Today has $1.50; a different date should be $0.
    assert.equal(skill.getDailySpend('2020-01-01'), 0);
    assert.ok(skill.getDailySpend() > 0);
  });

  it('handles fractional cents without losing precision', async () => {
    await skill.init(makeCtx());
    await skill.recordUsage('claude-opus-4-6', 0.001);
    const v = skill.getDailySpend();
    assert.ok(Math.abs(v - 0.001) < 0.0001);
  });
});

describe('token-tracker — bot_name PK (regression for ON CONFLICT bug)', () => {
  it('recordUsage twice for the same bot+model bumps call_count via ON CONFLICT', async () => {
    // Repro for the 2026-05-25 prod incident: SqliteError "ON CONFLICT clause
    // does not match any PRIMARY KEY or UNIQUE constraint" when the SQL did
    // ON CONFLICT(date, model) but the table PK was (date, model, bot_name).
    await skill.init(makeCtx('Kristina'));
    await skill.recordUsage('claude-opus-4-6', 0.10);
    await skill.recordUsage('claude-opus-4-6', 0.20);
    const summary = skill.getUsageSummary(1);
    assert.equal(summary.length, 1, 'one row, not two — ON CONFLICT must merge');
    assert.equal(summary[0].call_count, 2);
    assert.ok(Math.abs(summary[0].cost_cents - 30) < 0.01, 'cents summed (10 + 20)');
  });

  it('two different bots share the table without PK collisions', async () => {
    await skill.init(makeCtx('Kristina'));
    await skill.recordUsage('claude-opus-4-6', 0.50);
    await skill.destroy();

    const skill2 = new TokenTrackerSkill();
    await skill2.init(makeCtx('Trainer'));
    await skill2.recordUsage('claude-opus-4-6', 0.30);
    const summary = skill2.getUsageSummary(1);
    await skill2.destroy();
    assert.equal(summary.length, 1, 'second bot only sees its own row when querying its own DB');
  });

  it('legacy v100-only DB (2-col PK) is upgraded to 3-col by v101 migration', async () => {
    // Simulate a DB at the pre-2026-05-10 schema: v100 applied, no v101.
    const dbPath = join(tmpDir, 'data', 'TestBot.db');
    mkdirSync(join(tmpDir, 'data'), { recursive: true });
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE token_usage (
        date TEXT NOT NULL,
        model TEXT NOT NULL,
        call_count INTEGER NOT NULL DEFAULT 0,
        cost_cents REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, model)
      );
      INSERT INTO _migrations (version, name) VALUES (100, 'create_token_usage');
      INSERT INTO token_usage (date, model, call_count, cost_cents)
        VALUES ('2026-01-01', 'claude-opus-4-6', 5, 50);
    `);
    legacyDb.close();

    // Init the skill — v101 should run and recreate the table with 3-col PK.
    await skill.init(makeCtx('TestBot'));

    // Existing legacy row preserved with bot_name = 'unknown' default
    const summary = skill.getUsageSummary(365 * 10);
    const legacyRow = summary.find((r) => r.date === '2026-01-01');
    assert.ok(legacyRow, 'legacy row preserved across migration');
    assert.equal(legacyRow!.call_count, 5);

    // New writes work without ON CONFLICT errors
    await skill.recordUsage('claude-opus-4-6', 0.10);
    await skill.recordUsage('claude-opus-4-6', 0.20);
    const today = skill.getUsageSummary(1).find((r) => r.date === new Date().toISOString().split('T')[0]);
    assert.equal(today?.call_count, 2);
  });
});
