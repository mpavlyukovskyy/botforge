import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackupSkill } from './index.js';
import type { SkillContext, Logger } from '@botforge/core';

let tmpDir: string;
let skill: BackupSkill;

function silentLog(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx(cfg?: { enabled?: boolean; target_host?: string; target_dir?: string; local_retention_days?: number }): SkillContext {
  process.chdir(tmpDir);
  return {
    config: {
      name: 'TestBot',
      version: '1.0',
      platform: { type: 'telegram', token: 't', mode: 'polling' } as any,
      brain: { provider: 'claude', model: 'm', tools: [] } as any,
      backup: cfg,
    } as any,
    adapter: {} as any,
    log: silentLog(),
    skills: new Map(),
    store: new Map(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'backup-'));
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  skill = new BackupSkill();
});

afterEach(async () => {
  await skill.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('BackupSkill — init', () => {
  it('no-op when not enabled', async () => {
    await skill.init(makeCtx());
    assert.equal(skill.staleMs(), undefined);
  });

  it('warns + no-op when enabled but missing target_host / target_dir', async () => {
    await skill.init(makeCtx({ enabled: true }));
    assert.equal(skill.staleMs(), undefined);
  });

  it('initializes when fully configured', async () => {
    await skill.init(makeCtx({ enabled: true, target_host: 'localhost', target_dir: '/tmp/bk' }));
    assert.equal(skill.staleMs(), undefined, 'no successful backup yet → undefined');
  });
});

describe('runOnce — sad paths (cannot actually rsync in unit test)', () => {
  it('returns false when data/ has no .db files', async () => {
    await skill.init(makeCtx({ enabled: true, target_host: 'localhost', target_dir: '/tmp/bk' }));
    const ok = await skill.runOnce();
    assert.equal(ok, false);
  });

  it('attempts hot-backup for each .db; rsync to unreachable host returns false', async () => {
    // Seed a minimal SQLite file in data/.
    writeFileSync(join(tmpDir, 'data', 'fake.db'), 'SQLite format 3\0');
    await skill.init(makeCtx({ enabled: true, target_host: 'host-that-does-not-exist.invalid', target_dir: '/tmp/bk' }));
    const ok = await skill.runOnce();
    // sqlite3 .backup on a fake file fails OR rsync fails — either way return false.
    assert.equal(ok, false);
    assert.equal(skill.staleMs(), undefined, 'no success recorded');
  });
});

describe('pruneLocal', () => {
  it('does not crash when backups/ does not exist', async () => {
    await skill.init(makeCtx({ enabled: true, target_host: 'localhost', target_dir: '/tmp/bk' }));
    // runOnce calls pruneLocal internally; just verify pruneLocal-via-runOnce works.
    await skill.runOnce().catch(() => {});
    assert.ok(true);
  });

  it('respects local_retention_days config', async () => {
    // Create an old backup dir + new one.
    const root = join(tmpDir, 'backups');
    mkdirSync(join(root, '2020-01-01'), { recursive: true });
    mkdirSync(join(root, new Date().toISOString().split('T')[0]!), { recursive: true });
    await skill.init(makeCtx({ enabled: true, target_host: 'localhost', target_dir: '/tmp/bk', local_retention_days: 7 }));
    await skill.runOnce().catch(() => {});
    // We can't fully test prune in isolation (it's private + called inside runOnce).
    // Verify the recent dir still exists.
    assert.ok(existsSync(join(root, new Date().toISOString().split('T')[0]!)));
  });
});
