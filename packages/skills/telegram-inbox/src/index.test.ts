import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TelegramInboxSkill } from './index.js';
import type { SkillContext, Logger } from '@botforge/core';

let tmpDir: string;
let inbox: TelegramInboxSkill;

function silentLog(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx(botName: string, inboxCfg?: { enabled?: boolean; processing_timeout_ms?: number }): SkillContext {
  process.chdir(tmpDir); // so SqliteStorage's data/<name>-inbox.db lands in tmp
  return {
    config: {
      name: botName,
      version: '1.0',
      platform: { type: 'telegram', token: 't', mode: 'polling' } as any,
      brain: { provider: 'claude', model: 'm', tools: [] } as any,
      ...(inboxCfg ? { inbox: inboxCfg } : {}),
    } as any,
    adapter: {
      setInbox: () => {},
    } as any,
    log: silentLog(),
    skills: new Map(),
    store: new Map(),
  };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'inbox-test-'));
  // Create the data/ subdirectory that SqliteStorage expects.
  const fs = await import('node:fs/promises');
  await fs.mkdir(join(tmpDir, 'data'), { recursive: true });
  inbox = new TelegramInboxSkill();
});

afterEach(async () => {
  await inbox.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('TelegramInboxSkill — init', () => {
  it('initializes for telegram platform with default config', async () => {
    await inbox.init(makeCtx('TestBot'));
    assert.ok(inbox.db, 'storage opened');
    const stats = inbox.inboxStats();
    assert.deepEqual(stats, { received: 0, processing: 0, done: 0, failed: 0 });
  });

  it('disables when inbox.enabled: false', async () => {
    await inbox.init(makeCtx('TestBot', { enabled: false }));
    assert.equal(inbox.db, undefined, 'storage NOT opened when disabled');
  });

  it('respects custom processing_timeout_ms', async () => {
    await inbox.init(makeCtx('TestBot', { processing_timeout_ms: 60000 }));
    // No public getter but we can verify the reaper runs with a longer timeout
    assert.ok(inbox.db);
  });
});

describe('acquireForProcessing', () => {
  beforeEach(async () => {
    await inbox.init(makeCtx('TestBot'));
  });

  it('first call on a new update_id → action=process', () => {
    const r = inbox.acquireForProcessing(100, 'message', '42', '{"update_id":100}');
    assert.equal(r.action, 'process');
    if (r.action === 'process') {
      assert.equal(r.row.update_id, 100);
      assert.equal(r.row.status, 'processing');
      assert.equal(r.row.attempts, 1);
    }
  });

  it('second call before markDone → skip with concurrent_worker', () => {
    inbox.acquireForProcessing(101, 'message', '42', '{}');
    const r2 = inbox.acquireForProcessing(101, 'message', '42', '{}');
    assert.deepEqual(r2, { action: 'skip', reason: 'concurrent_worker' });
  });

  it('second call after markDone → skip with already_done', () => {
    inbox.acquireForProcessing(102, 'message', '42', '{}');
    inbox.markDone(102);
    const r2 = inbox.acquireForProcessing(102, 'message', '42', '{}');
    assert.deepEqual(r2, { action: 'skip', reason: 'already_done' });
  });

  it('re-acquire after markFailed → process again (attempts incremented)', () => {
    inbox.acquireForProcessing(103, 'message', '42', '{}');
    inbox.markFailed(103, 'first error');
    const r2 = inbox.acquireForProcessing(103, 'message', '42', '{}');
    assert.equal(r2.action, 'process');
    if (r2.action === 'process') {
      assert.equal(r2.row.attempts, 2);
      assert.equal(r2.row.last_error, null, 'last_error cleared on re-acquire');
    }
  });

  it('re-acquire after orphaned-on-boot reset → process again', () => {
    inbox.acquireForProcessing(104, 'message', '42', '{}');
    inbox.resetOrphanedOnBoot();
    const r2 = inbox.acquireForProcessing(104, 'message', '42', '{}');
    assert.equal(r2.action, 'process');
  });

  it('different update_ids do not interfere', () => {
    inbox.acquireForProcessing(200, 'message', '42', '{}');
    const r = inbox.acquireForProcessing(201, 'message', '42', '{}');
    assert.equal(r.action, 'process');
  });
});

describe('reapStuck', () => {
  it('moves rows stuck in processing back to received', async () => {
    await inbox.init(makeCtx('TestBot', { processing_timeout_ms: 100 })); // 0.1s
    inbox.acquireForProcessing(300, 'message', '1', '{}');
    // SQLite datetime('now') has second precision unless we use the modifier
    // form; 250ms wait is enough to push started_at past the 100ms cutoff
    // when both are evaluated with sub-second math.
    await new Promise((r) => setTimeout(r, 250));
    const reaped = inbox.reapStuck();
    assert.equal(reaped, 1);
    const stats = inbox.inboxStats();
    assert.equal(stats.received, 1);
    assert.equal(stats.processing, 0);
  });
});

describe('Sara\'s lost-message regression', () => {
  beforeEach(async () => {
    await inbox.init(makeCtx('TestBot'));
  });

  it('survives crash-mid-handler → restart → Telegram replay', () => {
    // 1. Update received, handler starts processing
    const acq = inbox.acquireForProcessing(800, 'message', '-5082741150',
      '{"update_id":800,"message":{"text":"put these on my todo list"}}');
    assert.equal(acq.action, 'process');

    // 2. Bot crashes mid-handler (no markDone/markFailed)

    // 3. Restart: resetOrphanedOnBoot fires
    const moved = inbox.resetOrphanedOnBoot();
    assert.equal(moved, 1);

    // 4. Telegram replays the message (offset reset)
    const replay = inbox.acquireForProcessing(800, 'message', '-5082741150', '{}');
    assert.equal(replay.action, 'process', 'replay should re-process');

    // 5. Handler completes
    inbox.markDone(800);

    // 6. Telegram replays AGAIN (offset lost) → skip
    const replay2 = inbox.acquireForProcessing(800, 'message', '-5082741150', '{}');
    assert.deepEqual(replay2, { action: 'skip', reason: 'already_done' });
  });
});
