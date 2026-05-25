import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldProcessMessage, type ReceptionContext } from './reception.js';
import type { IncomingMessage } from './adapter.js';
import type { Reception } from './schema.js';

function msg(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    id: '1',
    chatId: 'c',
    userId: 'u',
    type: 'text',
    timestamp: new Date(),
    ...overrides,
  } as IncomingMessage;
}

const BOT: ReceptionContext = { botId: '99', botUsername: 'mybot' };

describe('group_mode rules', () => {
  it('group_mode=ignore drops all group messages', () => {
    const d = shouldProcessMessage(msg({ isGroup: true, text: 'hi @mybot' }), { group_mode: 'ignore' } as Reception, BOT);
    assert.equal(d.process, false);
    if (!d.process) assert.match(d.reason, /group_mode=ignore/);
  });

  it('group_mode=always processes all group messages', () => {
    const d = shouldProcessMessage(msg({ isGroup: true, text: 'random chatter' }), { group_mode: 'always' } as Reception, BOT);
    assert.equal(d.process, true);
  });

  it('group_mode default (no config) acts like "always"', () => {
    const d = shouldProcessMessage(msg({ isGroup: true, text: 'hi' }), undefined, BOT);
    assert.equal(d.process, true);
  });

  it('group_mode=passive drops messages that miss every trigger', () => {
    const d = shouldProcessMessage(msg({ isGroup: true, text: 'no triggers here' }), { group_mode: 'passive' } as Reception, BOT);
    assert.equal(d.process, false);
  });

  it('group_mode=passive processes @mention with word boundary', () => {
    const d = shouldProcessMessage(msg({ isGroup: true, text: 'hey @mybot do something' }), { group_mode: 'passive' } as Reception, BOT);
    assert.equal(d.process, true);
  });

  it('group_mode=passive does NOT process partial-mention "@mybot2"', () => {
    const d = shouldProcessMessage(msg({ isGroup: true, text: 'hey @mybot2 do something' }), { group_mode: 'passive' } as Reception, BOT);
    assert.equal(d.process, false);
  });

  it('group_mode=passive processes reply to this bot', () => {
    const d = shouldProcessMessage(
      msg({ isGroup: true, text: 'yes please', replyToUserId: '99' }),
      { group_mode: 'passive' } as Reception,
      BOT,
    );
    assert.equal(d.process, true);
  });

  it('group_mode=passive does NOT process reply to a DIFFERENT user', () => {
    const d = shouldProcessMessage(
      msg({ isGroup: true, text: 'yes please', replyToUserId: '42' }),
      { group_mode: 'passive' } as Reception,
      BOT,
    );
    assert.equal(d.process, false);
  });

  it('group_mode=passive processes keyword match (case-insensitive by default)', () => {
    const d = shouldProcessMessage(
      msg({ isGroup: true, text: 'I think Kristina should know' }),
      { group_mode: 'passive', keywords: ['kristina'] } as Reception,
      BOT,
    );
    assert.equal(d.process, true);
  });

  it('group_mode=passive processes pattern match', () => {
    const d = shouldProcessMessage(
      msg({ isGroup: true, text: 'CASE-12345' }),
      { group_mode: 'passive', patterns: ['CASE-\\d+'] } as Reception,
      BOT,
    );
    assert.equal(d.process, true);
  });

  it('group_mode=passive tolerates invalid regex pattern (does not throw)', () => {
    // unbalanced paren should be caught, not crash the handler
    const d = shouldProcessMessage(
      msg({ isGroup: true, text: 'whatever' }),
      { group_mode: 'passive', patterns: ['(invalid'] } as Reception,
      BOT,
    );
    assert.equal(d.process, false);
  });
});

describe('dm_mode rules', () => {
  it('dm_mode=ignore drops DMs', () => {
    const d = shouldProcessMessage(msg({ text: 'hi' }), { dm_mode: 'ignore' } as Reception, BOT);
    assert.equal(d.process, false);
    if (!d.process) assert.match(d.reason, /dm_mode=ignore/);
  });

  it('dm_mode=always processes DMs', () => {
    const d = shouldProcessMessage(msg({ text: 'random' }), { dm_mode: 'always' } as Reception, BOT);
    assert.equal(d.process, true);
  });

  it('dm_mode default (no config) acts like "always"', () => {
    const d = shouldProcessMessage(msg({ text: 'hi' }), undefined, BOT);
    assert.equal(d.process, true);
  });

  it('dm_mode=keyword_only drops when no keyword matches', () => {
    const d = shouldProcessMessage(
      msg({ text: 'just chatting' }),
      { dm_mode: 'keyword_only', keywords: ['help'] } as Reception,
      BOT,
    );
    assert.equal(d.process, false);
  });

  it('dm_mode=keyword_only processes when a keyword matches', () => {
    const d = shouldProcessMessage(
      msg({ text: 'i need HELP please' }),
      { dm_mode: 'keyword_only', keywords: ['help'] } as Reception,
      BOT,
    );
    assert.equal(d.process, true);
  });
});

describe('case sensitivity', () => {
  it('keyword match is case-INsensitive by default', () => {
    const d = shouldProcessMessage(
      msg({ text: 'Help me' }),
      { dm_mode: 'keyword_only', keywords: ['HELP'] } as Reception,
      BOT,
    );
    assert.equal(d.process, true);
  });

  it('keyword match honors case_sensitive=true', () => {
    const d = shouldProcessMessage(
      msg({ text: 'help me' }),
      { dm_mode: 'keyword_only', keywords: ['HELP'], case_sensitive: true } as Reception,
      BOT,
    );
    assert.equal(d.process, false);
  });
});
