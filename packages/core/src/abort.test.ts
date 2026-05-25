import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { withTimeout, TimeoutError, anySignal } from './abort.js';

describe('withTimeout', () => {
  it('returns the work result when it completes inside the deadline', async () => {
    const result = await withTimeout(
      async () => 'done',
      { timeoutMs: 1000, label: 'test' },
    );
    assert.equal(result, 'done');
  });

  it('throws TimeoutError when work runs past deadline', async () => {
    await assert.rejects(
      withTimeout(
        () => new Promise((r) => setTimeout(r, 200)),
        { timeoutMs: 50, label: 'slow-work' },
      ),
      (err) => err instanceof TimeoutError && /slow-work/.test(err.message),
    );
  });

  it('propagates non-timeout errors verbatim', async () => {
    await assert.rejects(
      withTimeout(
        async () => { throw new Error('something else'); },
        { timeoutMs: 1000, label: 'test' },
      ),
      /something else/,
    );
  });

  it('passes a signal that fires on timeout, allowing the work to observe', async () => {
    let observedAbort = false;
    try {
      await withTimeout(
        (signal) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            observedAbort = true;
            reject(signal.reason);
          });
          // Otherwise wait forever
        }),
        { timeoutMs: 50, label: 'observe-abort' },
      );
    } catch {
      // expected
    }
    assert.ok(observedAbort);
  });

  it('parent abort cascades to inner signal', async () => {
    const parent = new AbortController();
    let innerAborted = false;
    const work = withTimeout(
      (signal) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          innerAborted = true;
          reject(signal.reason);
        });
      }),
      { timeoutMs: 1000, label: 'cascading', parent: parent.signal },
    );
    setTimeout(() => parent.abort(new Error('parent gave up')), 20);
    await assert.rejects(work);
    assert.ok(innerAborted);
  });

  it('successful completion clears the timer (no spurious abort)', async () => {
    let called = 0;
    for (let i = 0; i < 3; i++) {
      await withTimeout(async () => { called++; return 'x'; }, { timeoutMs: 1000, label: 't' });
    }
    assert.equal(called, 3);
  });
});

describe('anySignal', () => {
  it('returns a signal that fires when any input fires', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal(a.signal, b.signal);
    assert.equal(combined.aborted, false);
    b.abort(new Error('B fired'));
    assert.equal(combined.aborted, true);
  });

  it('returns an already-aborted signal if one input is already aborted', () => {
    const a = new AbortController();
    a.abort(new Error('A already gone'));
    const b = new AbortController();
    const combined = anySignal(a.signal, b.signal);
    assert.equal(combined.aborted, true);
  });

  it('ignores undefined inputs', () => {
    const combined = anySignal(undefined, undefined);
    assert.equal(combined.aborted, false);
  });
});
