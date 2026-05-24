import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { WorkspaceMonitorSkill } from './index.js';
import type { SkillContext, Logger } from '@botforge/core';

let skill: WorkspaceMonitorSkill;
let sentMessages: Array<{ chatId: string; text: string }>;
let mockSpend: number;

function silentLog(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx(monitorCfg?: { enabled?: boolean; cap_usd?: number; assumed_workspace_share?: number; admin_chat_id?: string }, spend = 0): SkillContext {
  mockSpend = spend;
  return {
    config: {
      name: 'TestBot',
      version: '1.0',
      platform: { type: 'telegram', token: 't', mode: 'polling', chat_ids: ['admin-123'] } as any,
      brain: { provider: 'claude', model: 'm', tools: [] } as any,
      workspace_monitor: monitorCfg,
    } as any,
    adapter: {
      async send(msg: { chatId: string; text: string }) {
        sentMessages.push({ chatId: msg.chatId, text: msg.text });
        return 'msg-id';
      },
    } as any,
    log: silentLog(),
    skills: new Map([
      ['token-tracker', { name: 'token-tracker', getDailySpend: () => mockSpend } as any],
    ]),
    store: new Map(),
  };
}

beforeEach(() => {
  skill = new WorkspaceMonitorSkill();
  sentMessages = [];
});

afterEach(async () => {
  await skill.destroy();
});

describe('WorkspaceMonitorSkill — init', () => {
  it('no-op when not enabled', async () => {
    await skill.init(makeCtx());
    assert.equal(await skill.check(), 'ok');
  });

  it('no-op when enabled but no cap configured', async () => {
    await skill.init(makeCtx({ enabled: true }));
    assert.equal(await skill.check(), 'ok');
  });

  it('initializes with cap_usd from YAML', async () => {
    await skill.init(makeCtx({ enabled: true, cap_usd: 30 }, 0));
    assert.equal(await skill.check(), 'ok');
  });

  it('initializes with ANTHROPIC_WORKSPACE_CAP_USD env when YAML cap missing', async () => {
    process.env.ANTHROPIC_WORKSPACE_CAP_USD = '20';
    try {
      await skill.init(makeCtx({ enabled: true }));
      // spend = 0 → no alert
      assert.equal(await skill.check(), 'ok');
    } finally {
      delete process.env.ANTHROPIC_WORKSPACE_CAP_USD;
    }
  });
});

describe('check thresholds', () => {
  it('below 80% returns ok and sends no alert', async () => {
    await skill.init(makeCtx({ enabled: true, cap_usd: 10 }, 5));
    assert.equal(await skill.check(), 'ok');
    assert.equal(sentMessages.length, 0);
  });

  it('at >= 80% returns warn and DMs admin', async () => {
    await skill.init(makeCtx({ enabled: true, cap_usd: 10 }, 8.5));
    assert.equal(await skill.check(), 'warn');
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /Workspace cap warning/);
    assert.equal(sentMessages[0].chatId, 'admin-123');
  });

  it('warn DM only fires once per day (re-check is no-op)', async () => {
    await skill.init(makeCtx({ enabled: true, cap_usd: 10 }, 8.5));
    await skill.check();
    await skill.check();
    await skill.check();
    assert.equal(sentMessages.length, 1, 'multiple checks same day → still only 1 alert');
  });

  it('at >= 100% returns exhausted and DMs admin', async () => {
    await skill.init(makeCtx({ enabled: true, cap_usd: 10 }, 11));
    assert.equal(await skill.check(), 'exhausted');
    assert.match(sentMessages[0].text, /Workspace cap exhausted/);
  });

  it('respects assumed_workspace_share — share=0.5, cap=20, spend=8.5 → 85% of share → warn', async () => {
    await skill.init(makeCtx({ enabled: true, cap_usd: 20, assumed_workspace_share: 0.5 }, 8.5));
    assert.equal(await skill.check(), 'warn');
  });

  it('explicit admin_chat_id overrides platform.chat_ids[0]', async () => {
    await skill.init(makeCtx({ enabled: true, cap_usd: 10, admin_chat_id: 'override-999' }, 11));
    await skill.check();
    assert.equal(sentMessages[0].chatId, 'override-999');
  });
});
