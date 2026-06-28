import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type TelegramBot from 'node-telegram-bot-api';

import { hostMessageIdFromCallback } from './index.js';

/**
 * Regression: convertCallback must expose query.message.message_id as the
 * host-message id, distinct from query.id (the callback-query id). Conflating
 * them broke every inline-button edit in the fleet — Jun 2026.
 */
describe('hostMessageIdFromCallback', () => {
  it('returns the host message_id, not the callback-query id', () => {
    const query = {
      id: '4827163590182734', // callback-query id
      from: { id: 1, is_bot: false, first_name: 'Eddy' },
      message: { message_id: 142, date: 0, chat: { id: -5181340999, type: 'group' } },
      data: 'ack:9001',
    } as unknown as TelegramBot.CallbackQuery;

    assert.equal(hostMessageIdFromCallback(query), '142');
    assert.notEqual(hostMessageIdFromCallback(query), query.id);
  });

  it('returns undefined when the host message is absent', () => {
    const query = { id: '999', from: { id: 1 }, data: 'x' } as unknown as TelegramBot.CallbackQuery;
    assert.equal(hostMessageIdFromCallback(query), undefined);
  });
});
