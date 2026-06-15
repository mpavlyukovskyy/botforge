/**
 * Tests for sendWithMarkdownFallback — proves a task title that breaks Telegram
 * Markdown parsing no longer drops the whole message (the 2026-06-14 daily
 * digest failure).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sendWithMarkdownFallback } from './safe-send.js';

let calls;
function makeCtx(sendImpl) {
  return {
    adapter: { send: async (m) => { calls.push(m); return sendImpl ? sendImpl(m) : 99; } },
    log: { warn() {}, info() {}, error() {} },
  };
}

beforeEach(() => { calls = []; });

describe('sendWithMarkdownFallback', () => {
  it('sends with Markdown on the happy path (no retry)', async () => {
    const ctx = makeCtx(() => 1);
    const id = await sendWithMarkdownFallback(ctx, { chatId: '1', text: 'hi' });
    expect(id).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].parseMode).toBe('Markdown');
  });

  it('retries as plain text when Telegram rejects the entities', async () => {
    let first = true;
    const ctx = makeCtx(() => {
      if (first) { first = false; throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 1412"); }
      return 7;
    });
    const id = await sendWithMarkdownFallback(ctx, { chatId: '1', text: 'task *unbalanced' });
    expect(id).toBe(7);
    expect(calls.length).toBe(2);
    expect(calls[0].parseMode).toBe('Markdown');     // first attempt
    expect(calls[1].parseMode).toBeUndefined();        // retry has no parse mode
    expect(calls[1].text).toBe('task *unbalanced');    // same text
  });

  it('rethrows non-parse errors (does not silently swallow real failures)', async () => {
    const ctx = makeCtx(() => { throw new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user'); });
    await expect(sendWithMarkdownFallback(ctx, { chatId: '1', text: 'x' })).rejects.toThrow(/403/);
    expect(calls.length).toBe(1); // no retry
  });
});
