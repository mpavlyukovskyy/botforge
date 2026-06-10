import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MockAdapter } from './MockAdapter.js';
import type { IncomingMessage } from '../adapter.js';

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter();
});

describe('MockAdapter — basic lifecycle', () => {
  it('starts in disconnected state and reports isConnected accurately', async () => {
    assert.equal(mock.isConnected(), false);
    await mock.start();
    assert.equal(mock.isConnected(), true);
    await mock.stop();
    assert.equal(mock.isConnected(), false);
  });
});

describe('MockAdapter — message routing', () => {
  it('inject delivers a synthesized message to the registered handler', async () => {
    let received: IncomingMessage | undefined;
    mock.onMessage(async (msg) => { received = msg; });

    await mock.inject({ text: 'hello world', chatId: 'chat-42' });

    assert.ok(received);
    assert.equal(received!.text, 'hello world');
    assert.equal(received!.chatId, 'chat-42');
    assert.equal(received!.type, 'text');
  });

  it('inject throws when no onMessage handler is registered', async () => {
    await assert.rejects(
      mock.inject({ text: 'no handler' }),
      /no onMessage handler/,
    );
  });

  it('onMessage refuses double-registration (regression guard)', () => {
    mock.onMessage(async () => {});
    assert.throws(() => mock.onMessage(async () => {}), /already registered/);
  });

  it('two different chats do not bleed into each other (sent[] is global but tagged)', async () => {
    mock.onMessage(async (msg) => {
      await mock.send({ chatId: msg.chatId, text: `ack-${msg.chatId}` });
    });
    await mock.inject({ chatId: 'chat-A', text: 'a' });
    await mock.inject({ chatId: 'chat-B', text: 'b' });
    assert.equal(mock.sent.length, 2);
    assert.equal(mock.sent[0]!.chatId, 'chat-A');
    assert.equal(mock.sent[1]!.chatId, 'chat-B');
  });
});

describe('MockAdapter — outgoing surface', () => {
  it('send accumulates in sent[] with deterministic message IDs', async () => {
    const id1 = await mock.send({ chatId: 'c1', text: 'one' });
    const id2 = await mock.send({ chatId: 'c1', text: 'two' });
    assert.equal(id1, 'mock-msg-1');
    assert.equal(id2, 'mock-msg-2');
    assert.equal(mock.sent.length, 2);
    assert.equal(mock.sent[0]!.text, 'one');
    assert.equal(mock.sent[1]!.text, 'two');
  });

  it('edit, delete, setMessageReaction, sendChatAction all log to their respective arrays', async () => {
    await mock.edit('msg-1', 'chat-x', { text: 'updated' });
    await mock.delete('msg-2', 'chat-x');
    await mock.setMessageReaction('chat-x', 'msg-3', '👍');
    await mock.sendChatAction('chat-x', 'typing');

    assert.equal(mock.edits.length, 1);
    assert.equal(mock.edits[0]!.patch.text, 'updated');
    assert.equal(mock.deletes.length, 1);
    assert.equal(mock.reactions[0]!.emoji, '👍');
    assert.equal(mock.chatActions[0]!.action, 'typing');
  });
});

describe('MockAdapter — callbacks + group joins', () => {
  it('injectCallback routes to the registered callback handler', async () => {
    let received: IncomingMessage | undefined;
    mock.onCallback(async (cb) => { received = cb; });
    await mock.injectCallback({ callbackData: 'approve:42', chatId: 'chat-1' });
    assert.equal(received?.type, 'callback');
    assert.equal(received?.callbackData, 'approve:42');
  });

  it('fireGroupJoin triggers the join handler', () => {
    let observed: { chatId: string; title: string } | undefined;
    mock.onGroupJoin((chatId, title) => { observed = { chatId, title }; });
    mock.fireGroupJoin('chat-99', 'Test Group');
    assert.deepEqual(observed, { chatId: 'chat-99', title: 'Test Group' });
  });
});

describe('MockAdapter — files + bot identity', () => {
  it('downloadFile returns the seeded Buffer; throws on unknown ID', async () => {
    const m = new MockAdapter({ files: { 'file-abc': Buffer.from('hello') } });
    const buf = await m.downloadFile('file-abc');
    assert.equal(buf.toString(), 'hello');
    await assert.rejects(m.downloadFile('file-missing'), /no fixture/);
  });

  it('getBotInfo returns the configured identity', async () => {
    const m = new MockAdapter({ botInfo: { id: '999', username: 'testbot' } });
    const info = await m.getBotInfo();
    assert.deepEqual(info, { id: '999', username: 'testbot' });
  });
});

describe('MockAdapter — clear() resets in-memory state', () => {
  it('clear empties all log arrays', async () => {
    mock.onMessage(async () => {});
    await mock.send({ chatId: 'c', text: 't' });
    await mock.edit('m', 'c', { text: 'x' });
    mock.clear();
    assert.equal(mock.sent.length, 0);
    assert.equal(mock.edits.length, 0);
  });
});
