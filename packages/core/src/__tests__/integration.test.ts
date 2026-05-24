/**
 * Integration tests — exercise the full message pipeline through startBot
 * with a MockAdapter standing in for the real Telegram adapter.
 *
 * These tests guard against behavior regressions from the T1.4 extractions
 * (reception, brain-processor, skill-loader, BotStore). The runtime is
 * driven end-to-end without any LLM call by using a custom messageProcessor
 * that records what reception decided to do.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startBot, type BotInstance } from '../runtime.js';
import { MockAdapter } from '../testing/MockAdapter.js';

let tmpDir: string;
let configPath: string;
let mock: MockAdapter;
let instance: BotInstance | undefined;
let processedCount = 0;
let processedMessages: Array<{ chatId: string; text?: string; type: string }> = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'botforge-it-'));
  configPath = join(tmpDir, 'bot.yaml');
  mock = new MockAdapter({ botInfo: { id: '99', username: 'testbot' } });
  processedCount = 0;
  processedMessages = [];
  instance = undefined;
});

afterEach(async () => {
  if (instance?.adapter) await instance.adapter.stop().catch(() => {});
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  writeFileSync(configPath, yaml, 'utf-8');
}

async function bootBot(yaml: string): Promise<BotInstance> {
  writeConfig(yaml);
  return startBot(configPath, {
    createAdapter: () => mock,
    messageProcessor: async (msg) => {
      processedCount++;
      processedMessages.push({ chatId: msg.chatId, text: msg.text, type: msg.type });
    },
  });
}

const BASIC_CONFIG = `
name: TestBot
version: "1.0"
platform:
  type: telegram
  token: x
  mode: polling
brain:
  provider: claude
  model: claude-haiku-4-5-20251001
  system_prompt: "test"
`;

describe('integration: basic message handling', () => {
  it('startBot succeeds and adapter is started', async () => {
    instance = await bootBot(BASIC_CONFIG);
    assert.ok(mock.isConnected(), 'mock adapter should be started');
  });

  it('DM with default config (dm_mode=always) → processMessage invoked', async () => {
    instance = await bootBot(BASIC_CONFIG);
    await mock.inject({ text: 'hello bot', chatId: 'chat-1' });
    assert.equal(processedCount, 1);
    assert.equal(processedMessages[0].text, 'hello bot');
  });

  it('group passive mode + @mention → processed', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    group_mode: passive
    bot_username: testbot
`);
    await mock.inject({ text: '@testbot please help', isGroup: true });
    assert.equal(processedCount, 1);
  });

  it('group passive mode + no trigger → NOT processed', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    group_mode: passive
    bot_username: testbot
`);
    await mock.inject({ text: 'random chatter', isGroup: true });
    assert.equal(processedCount, 0);
  });

  it('dm_mode=ignore drops DMs silently', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    dm_mode: ignore
`);
    await mock.inject({ text: 'anyone there?' });
    assert.equal(processedCount, 0);
    assert.equal(mock.sent.length, 0, 'no message should be sent');
  });

  it('dm_mode=keyword_only requires a keyword match', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    dm_mode: keyword_only
    keywords:
      - help
`);
    await mock.inject({ text: 'random chatter' });
    assert.equal(processedCount, 0);
    await mock.inject({ text: 'I need HELP please' });
    assert.equal(processedCount, 1);
  });
});

describe('integration: bot identity from getBotInfo', () => {
  it('auto-detects bot identity from adapter.getBotInfo()', async () => {
    instance = await bootBot(BASIC_CONFIG);
    assert.equal(instance.botId, '99');
    assert.equal(instance.botUsername, 'testbot');
  });

  it('explicit bot_username in config takes precedence over auto-detect', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    bot_username: mybot
`);
    assert.equal(instance.botUsername, 'mybot');
  });
});

describe('integration: framework_sha exposure via getFrameworkSha', () => {
  it('framework SHA is stable across the bot lifetime', async () => {
    instance = await bootBot(BASIC_CONFIG);
    // The actual SHA value isn't asserted here — different test runs see
    // different SHAs depending on whether tests run vs source or dist. We
    // assert the API exists and returns a consistent string.
    const { getFrameworkSha } = await import('../framework-info.js');
    const sha1 = getFrameworkSha();
    const sha2 = getFrameworkSha();
    assert.equal(sha1, sha2);
    assert.ok(typeof sha1 === 'string' && sha1.length > 0);
  });
});

describe('integration: reception extraction parity', () => {
  // These tests pin the EXACT decision behavior of reception.ts against
  // pre-refactor expectations. If a future refactor changes the decision
  // for any of these inputs, this suite fails.

  it('reply to OTHER user in passive group → not processed', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    group_mode: passive
    bot_username: testbot
`);
    await mock.inject({ text: 'cool', isGroup: true, replyToUserId: 'someone-else' });
    assert.equal(processedCount, 0);
  });

  it('reply to THIS bot in passive group → processed', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    group_mode: passive
    bot_username: testbot
`);
    await mock.inject({ text: 'cool', isGroup: true, replyToUserId: '99' });
    assert.equal(processedCount, 1);
  });

  it('keyword match in passive group → processed', async () => {
    instance = await bootBot(BASIC_CONFIG + `
behavior:
  reception:
    group_mode: passive
    bot_username: testbot
    keywords:
      - kristina
`);
    await mock.inject({ text: 'tell Kristina about this', isGroup: true });
    assert.equal(processedCount, 1);
  });
});
