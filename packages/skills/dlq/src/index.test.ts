import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DlqSkill } from './index.js';
import type { SkillContext, Logger } from '@botforge/core';

let tmpDir: string;
let dlq: DlqSkill;

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
  tmpDir = mkdtempSync(join(tmpdir(), 'dlq-'));
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  dlq = new DlqSkill();
});

afterEach(async () => {
  await dlq.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('DlqSkill', () => {
  it('add records the failure and returns an id', async () => {
    await dlq.init(makeCtx());
    const id = dlq.add('cleancloud-sync', { orderId: 42 }, new Error('connection refused'));
    assert.ok(typeof id === 'number' && id > 0);
  });

  it('listPending returns the recorded failures', async () => {
    await dlq.init(makeCtx());
    dlq.add('cleancloud-sync', { orderId: 1 }, new Error('boom'));
    dlq.add('xero-push', { orderId: 2 }, new Error('429'));
    const rows = dlq.listPending();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'pending');
  });

  it('listPending filters by kind', async () => {
    await dlq.init(makeCtx());
    dlq.add('cleancloud-sync', { orderId: 1 }, new Error('boom'));
    dlq.add('xero-push', { orderId: 2 }, new Error('429'));
    const rows = dlq.listPending('xero-push');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'xero-push');
  });

  it('markReplayed removes a row from listPending', async () => {
    await dlq.init(makeCtx());
    const id = dlq.add('x', { a: 1 }, new Error('err'))!;
    dlq.markReplayed(id);
    assert.equal(dlq.listPending().length, 0);
    assert.equal(dlq.pendingCount(), 0);
  });

  it('markDead removes from pending but keeps the row', async () => {
    await dlq.init(makeCtx());
    const id = dlq.add('x', { a: 1 }, new Error('err'))!;
    dlq.markDead(id);
    assert.equal(dlq.pendingCount(), 0);
    // Row still exists; prune() with default 30d threshold keeps it.
    assert.equal(dlq.prune(30), 0);
  });

  it('opt-out via dlq.enabled=false disables the skill', async () => {
    const ctx = makeCtx();
    (ctx.config as any).dlq = { enabled: false };
    await dlq.init(ctx);
    // add is a no-op when disabled — returns undefined.
    const id = dlq.add('x', {}, new Error('boom'));
    assert.equal(id, undefined);
    assert.equal(dlq.pendingCount(), 0);
  });

  it('truncates oversized payloads + errors', async () => {
    await dlq.init(makeCtx());
    const bigPayload = 'x'.repeat(200_000);
    const bigError = new Error('y'.repeat(10_000));
    const id = dlq.add('x', bigPayload, bigError)!;
    const row = dlq.listPending()[0];
    assert.ok(row.payload.length <= 100_000);
    assert.ok(row.error.length <= 5000 + 20);
    void id;
  });
});
