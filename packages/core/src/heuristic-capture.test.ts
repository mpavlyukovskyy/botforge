import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTask, heuristicTaskTitle, stripBotMention } from './heuristic-capture.js';
import { LLM_UNAVAILABLE_CLASSES } from './error-messages.js';

describe('stripBotMention', () => {
  it('strips a known bot username anywhere', () => {
    assert.equal(stripBotMention('buy milk @KristinaWorkingbot today', 'KristinaWorkingbot'), 'buy milk today');
  });
  it('strips a leading @token when username is unknown', () => {
    assert.equal(stripBotMention('@KristinaWorkingbot buy milk'), 'buy milk');
  });
  it('keeps a mid-sentence @assignee when username unknown', () => {
    assert.equal(stripBotMention('assign @kristina to buy milk'), 'assign @kristina to buy milk');
  });
});

describe('looksLikeTask — captures real action items', () => {
  for (const t of [
    '@KristinaWorkingbot buy distilled water for the 8 sleep',
    'send the POS SOP to Eddy',
    'check cost implications for switching house insurance to tenanted property',
    'order shirts and shorts for Mark',
  ]) {
    it(`captures: "${t}"`, () => assert.equal(looksLikeTask(t), true));
  }
});

describe('looksLikeTask — skips non-tasks (protects the pay board)', () => {
  for (const t of [
    'done',
    "it's done",
    'this is done',
    'ok thanks',
    'yes',
    'ya',
    '@KristinaWorkingbot what is my balance?',
    'how much do I have?',
    'can you tell me the total?',
    '/status',
    'hi',
    '',
  ]) {
    it(`skips: "${t}"`, () => assert.equal(looksLikeTask(t), false));
  }

  it('skips when only the bot mention is present', () => {
    assert.equal(looksLikeTask('@KristinaWorkingbot', 'KristinaWorkingbot'), false);
  });
});

describe('heuristicTaskTitle', () => {
  it('strips the leading mention and capitalizes', () => {
    assert.equal(heuristicTaskTitle('@KristinaWorkingbot buy distilled water'), 'Buy distilled water');
  });
  it('clamps very long titles', () => {
    const t = heuristicTaskTitle('x'.repeat(400));
    assert.ok(t.length <= 201);
    assert.ok(t.endsWith('…'));
  });
});

describe('LLM_UNAVAILABLE_CLASSES gate', () => {
  it('includes the AI-down classes', () => {
    for (const c of ['credit_balance', 'usage_limit', 'auth', 'overloaded', 'rate_limited', 'network', 'brain_timeout']) {
      assert.equal(LLM_UNAVAILABLE_CLASSES.has(c), true);
    }
  });
  it('EXCLUDES classes where capture would be wrong (db/tool/oversized/unknown)', () => {
    for (const c of ['db_error', 'tool_error', 'context_too_long', 'cli_failure', 'unknown']) {
      assert.equal(LLM_UNAVAILABLE_CLASSES.has(c), false);
    }
  });
});
