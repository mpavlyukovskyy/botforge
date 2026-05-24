import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TokenTrackerSkill } from './index.js';
import type { SkillContext, Logger } from '@botforge/core';

let tmpDir: string;
let skill: TokenTrackerSkill;

function silentLog(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx(): SkillContext {
  process.chdir(tmpDir);
  return {
    config: {
      name: 'TestBot',
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
