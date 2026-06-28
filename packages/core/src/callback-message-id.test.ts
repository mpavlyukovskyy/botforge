import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCallbackMessageId } from './runtime.js';
import type { IncomingMessage } from './adapter.js';

/**
 * Regression: a callback handler must edit the HOST message (the one carrying
 * the tapped keyboard), not the callback-query id. Using the query id raised
 * "ETELEGRAM: 400 Bad Request: message to edit not found" on every Findlays
 * order-ack tap (and every other fleet button-edit) — Jun 2026.
 */
function callback(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    id: '4827163590182734', // callback-query id (long, opaque)
    chatId: '-5181340999',
    userId: '381823289',
    type: 'callback',
    timestamp: new Date(0),
    ...partial,
  };
}

describe('resolveCallbackMessageId', () => {
  it('uses the host message id, NOT the callback-query id', () => {
    const cb = callback({ callbackMessageId: '142' });
    assert.equal(resolveCallbackMessageId(cb), '142');
    assert.notEqual(resolveCallbackMessageId(cb), cb.id);
  });

  it('falls back to id when no host message id is resolved', () => {
    const cb = callback({ callbackMessageId: undefined });
    assert.equal(resolveCallbackMessageId(cb), cb.id);
  });
});
