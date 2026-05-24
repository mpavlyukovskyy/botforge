import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TelegramOutboxSkill } from './index.js';
import type { SkillContext, Logger, OutgoingMessage, PlatformAdapter } from '@botforge/core';

let tmpDir: string;
let outbox: TelegramOutboxSkill;
let sendCalls: OutgoingMessage[];
let sendShouldThrow: Error | undefined;
let fakeAdapter: PlatformAdapter;

function silentLog(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx(overrides: { outbox?: { enabled?: boolean; poll_interval_ms?: number } } = {}): SkillContext {
  process.chdir(tmpDir);
  return {
    config: {
      name: 'TestBot',
      version: '1.0',
      platform: { type: 'telegram', token: 't', mode: 'polling' } as any,
      brain: { provider: 'claude', model: 'm', tools: [] } as any,
      outbox: overrides.outbox,
    } as any,
    adapter: fakeAdapter,
    log: silentLog(),
    skills: new Map(),
    store: new Map(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'outbox-'));
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  sendCalls = [];
  sendShouldThrow = undefined;
  fakeAdapter = {
    platform: 'telegram',
    async start() {},
    async stop() {},
    isConnected() { return true; },
    onMessage() {},
    onCallback() {},
    async send(msg: OutgoingMessage) {
      sendCalls.push(msg);
      if (sendShouldThrow) throw sendShouldThrow;
      return 'msg-id';
    },
  } as any;
  outbox = new TelegramOutboxSkill();
});

afterEach(async () => {
  await outbox.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('telegram-outbox — init', () => {
  it('initializes for telegram platform', async () => {
    await outbox.init(makeCtx());
    assert.deepEqual(outbox.stats(), { pending: 0, sent: 0, failed: 0 });
  });

  it('disables via outbox.enabled: false', async () => {
    await outbox.init(makeCtx({ outbox: { enabled: false } }));
    // enqueue is a no-op when disabled
    const id = outbox.enqueue({ chatId: 'c', text: 't' });
    assert.equal(id, undefined);
  });
});

describe('enqueue + drain — happy path', () => {
  it('enqueue persists immediately; drain sends', async () => {
    await outbox.init(makeCtx({ outbox: { poll_interval_ms: 99999 } })); // disable auto-worker
    const id = outbox.enqueue({ chatId: '42', text: 'hello' });
    assert.ok(typeof id === 'number' && id > 0);
    assert.equal(outbox.pendingCount(), 1);
    assert.equal(sendCalls.length, 0, 'send not called until drain');

    await outbox.drain();
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].text, 'hello');
    assert.equal(outbox.pendingCount(), 0);
    assert.equal(outbox.stats().sent, 1);
  });

  it('preserves enqueue order (FIFO)', async () => {
    await outbox.init(makeCtx({ outbox: { poll_interval_ms: 99999 } }));
    outbox.enqueue({ chatId: 'c', text: 'first' });
    outbox.enqueue({ chatId: 'c', text: 'second' });
    outbox.enqueue({ chatId: 'c', text: 'third' });

    await outbox.drain();
    await outbox.drain();
    await outbox.drain();

    assert.deepEqual(sendCalls.map((m) => m.text), ['first', 'second', 'third']);
  });
});

describe('retry + backoff', () => {
  it('on send error, increments attempts and schedules retry (does not stay pending)', async () => {
    await outbox.init(makeCtx({ outbox: { poll_interval_ms: 99999 } }));
    sendShouldThrow = new Error('429');
    outbox.enqueue({ chatId: 'c', text: 'will-fail' });
    await outbox.drain();
    // Still pending but with next_attempt_at set
    assert.equal(outbox.stats().pending, 1);
    // Without time travel, the second drain should NOT pick it up yet (next_attempt_at in future)
    sendShouldThrow = undefined;
    await outbox.drain();
    assert.equal(sendCalls.length, 1, 'no second attempt within backoff window');
  });

  it('exhausting backoffs marks failed + pushes to DLQ', async () => {
    let dlqCalled = false;
    const ctx = makeCtx({ outbox: { poll_interval_ms: 99999 } });
    ctx.skills.set('dlq', { add: () => { dlqCalled = true; return 1; }, name: 'dlq' } as any);
    await outbox.init(ctx);

    sendShouldThrow = new Error('persistent error');
    outbox.enqueue({ chatId: 'c', text: 'doomed' });

    // 5 drain attempts (4 backoffs + 1 final marker). Force the backoff-window
    // gate by manually clearing next_attempt_at between drains.
    for (let i = 0; i < 5; i++) {
      await outbox.drain();
      // Reset next_attempt_at so the next drain picks it up
      // (in real life the backoff timers would fire).
      (outbox as any).storage.db.prepare(
        `UPDATE tg_outbox SET next_attempt_at=NULL WHERE status='pending'`,
      ).run();
    }
    assert.equal(outbox.stats().failed, 1, 'row should be marked failed');
    assert.ok(dlqCalled, 'DLQ should have been called');
  });
});

describe('observability + cleanup', () => {
  it('stats reflects pending/sent/failed counts', async () => {
    await outbox.init(makeCtx({ outbox: { poll_interval_ms: 99999 } }));
    outbox.enqueue({ chatId: 'c', text: 'a' });
    outbox.enqueue({ chatId: 'c', text: 'b' });
    await outbox.drain();
    const s = outbox.stats();
    assert.equal(s.sent, 1);
    assert.equal(s.pending, 1);
  });

  it('pruneSent removes only old sent rows', async () => {
    await outbox.init(makeCtx({ outbox: { poll_interval_ms: 99999 } }));
    outbox.enqueue({ chatId: 'c', text: 'a' });
    await outbox.drain();
    // Backdate the row's sent_at
    (outbox as any).storage.db.prepare(
      `UPDATE tg_outbox SET sent_at = datetime('now', '-30 days') WHERE status='sent'`,
    ).run();
    outbox.enqueue({ chatId: 'c', text: 'b' });
    await outbox.drain();
    const removed = outbox.pruneSent(7);
    assert.equal(removed, 1);
    assert.equal(outbox.stats().sent, 1, 'recent sent row preserved');
  });
});
