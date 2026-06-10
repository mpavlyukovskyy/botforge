import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { HeartbeatSkill } from './index.js';
import type { SkillContext, Logger } from '@botforge/core';

let skill: HeartbeatSkill;
let fetchedUrls: string[];
let origFetch: typeof globalThis.fetch;

function silentLog(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx(heartbeatCfg?: { poll_url?: string; poll_interval_ms?: number; cron_urls?: Record<string, string> }): SkillContext {
  return {
    config: {
      name: 'TestBot',
      version: '1.0',
      platform: { type: 'telegram', token: 't', mode: 'polling' } as any,
      brain: { provider: 'claude', model: 'm', tools: [] } as any,
      health: heartbeatCfg ? { port: 9999, path: '/api/health', heartbeat: heartbeatCfg } : undefined,
    } as any,
    adapter: {} as any,
    log: silentLog(),
    skills: new Map(),
    store: new Map(),
  };
}

beforeEach(() => {
  skill = new HeartbeatSkill();
  fetchedUrls = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    fetchedUrls.push(String(url));
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  await skill.destroy();
  globalThis.fetch = origFetch;
});

describe('HeartbeatSkill — init', () => {
  it('no-op when no heartbeat config', async () => {
    await skill.init(makeCtx());
    assert.equal(fetchedUrls.length, 0);
  });

  it('initializes with poll_url', async () => {
    await skill.init(makeCtx({ poll_url: 'https://kuma.example.com/api/push/abc', poll_interval_ms: 99999 }));
    // Timer set up; we'll let it not fire by using a huge interval. Just verify init didn't crash.
    assert.ok(true);
  });
});

describe('pushCron', () => {
  it('fires GET to the configured URL for the named cron', async () => {
    await skill.init(makeCtx({
      cron_urls: { daily_digest: 'https://kuma.example.com/api/push/digest-token' },
    }));
    await skill.pushCron('daily_digest');
    assert.equal(fetchedUrls.length, 1);
    assert.match(fetchedUrls[0]!, /digest-token/);
  });

  it('no-op when the named cron has no URL', async () => {
    await skill.init(makeCtx({ cron_urls: { daily_digest: 'https://kuma.example.com/api/push/abc' } }));
    await skill.pushCron('unknown-cron');
    assert.equal(fetchedUrls.length, 0);
  });

  it('swallows fetch errors silently (bot keeps running)', async () => {
    await skill.init(makeCtx({ cron_urls: { x: 'https://invalid.example/abc' } }));
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof globalThis.fetch;
    // Must not throw.
    await skill.pushCron('x');
    assert.ok(true);
  });

  it('swallows non-2xx responses silently', async () => {
    await skill.init(makeCtx({ cron_urls: { x: 'https://kuma.example.com/api/push/missing' } }));
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof globalThis.fetch;
    await skill.pushCron('x');
    // No exception. We don't verify the log call here.
    assert.ok(true);
  });
});

describe('destroy', () => {
  it('clears the poll timer cleanly', async () => {
    await skill.init(makeCtx({ poll_url: 'https://kuma.example.com/api/push/x', poll_interval_ms: 99999 }));
    await skill.destroy();
    // No timer firing after destroy. Test would hang if it did.
    assert.ok(true);
  });
});
