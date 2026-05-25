import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyError,
  createState,
  onPollingError,
  onSuccessfulPoll,
  setPaused,
  type ResilienceState,
} from './polling-resilience.js';

function fakeError(message: string, code?: string): Error {
  const e = new Error(message) as NodeJS.ErrnoException;
  if (code) e.code = code;
  return e;
}

describe('classifyError', () => {
  it('marks EAI_AGAIN code as transient', () => {
    assert.equal(classifyError(fakeError('boom', 'EAI_AGAIN')), 'transient');
  });

  it('marks ECONNRESET code as transient', () => {
    assert.equal(classifyError(fakeError('boom', 'ECONNRESET')), 'transient');
  });

  it('marks "getaddrinfo EAI_AGAIN api.telegram.org" message as transient', () => {
    assert.equal(
      classifyError(new Error('getaddrinfo EAI_AGAIN api.telegram.org')),
      'transient',
    );
  });

  it('marks "socket hang up" as transient', () => {
    assert.equal(classifyError(new Error('socket hang up')), 'transient');
  });

  it('marks "ETELEGRAM: 401 Unauthorized" as fatal', () => {
    assert.equal(classifyError(new Error('ETELEGRAM: 401 Unauthorized')), 'fatal');
  });

  it('marks unrelated errors as unknown', () => {
    assert.equal(classifyError(new Error('something weird happened')), 'unknown');
  });

  it('returns unknown for null/undefined', () => {
    assert.equal(classifyError(null), 'unknown');
    assert.equal(classifyError(undefined), 'unknown');
  });
});

describe('onPollingError — backoff escalation', () => {
  it('first transient error returns backoff with 5s and level 1', () => {
    const state = createState({ now: () => 1_000_000 });
    const d = onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    assert.deepEqual(d, { action: 'backoff', ms: 5_000, level: 1 });
  });

  it('escalates 5s → 15s → 60s → 5min across successive errors', () => {
    let t = 1_000_000;
    const state = createState({ now: () => t });
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
      if (d.action === 'backoff') seen.push(d.ms);
      t += 100;
    }
    // The 5th call hits the cap (300_000 stays at the top of the schedule).
    assert.deepEqual(seen, [5_000, 15_000, 60_000, 300_000, 300_000]);
  });

  it('successful poll resets the escalation', () => {
    let t = 1_000_000;
    const state = createState({ now: () => t });

    onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    onSuccessfulPoll(state);

    const d = onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    assert.deepEqual(d, { action: 'backoff', ms: 5_000, level: 1 });
  });

  it('isPaused suppresses re-escalation while a backoff is in flight', () => {
    let t = 1_000_000;
    const state = createState({ now: () => t });
    onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    setPaused(state, true);

    const d = onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    assert.deepEqual(d, { action: 'noop' });
  });

  it('non-transient unknown errors return log_only — no exit, no backoff', () => {
    const state = createState({ now: () => 1_000_000 });
    const d = onPollingError(state, new Error('weird thing happened'));
    assert.deepEqual(d, { action: 'log_only' });
  });

  it('fatal errors (401) return exit_fatal', () => {
    const state = createState({ now: () => 1_000_000 });
    const d = onPollingError(state, new Error('ETELEGRAM: 401 Unauthorized'));
    assert.deepEqual(d, { action: 'exit_fatal' });
  });
});

describe('onPollingError — sliding-window watchdog', () => {
  it('15 errors in 60s triggers exit_watchdog', () => {
    let t = 1_000_000;
    const state = createState({ now: () => t });
    let lastDecision: ReturnType<typeof onPollingError> = { action: 'noop' };
    for (let i = 0; i < 15; i++) {
      lastDecision = onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
      t += 1_000;
    }
    assert.equal(lastDecision.action, 'exit_watchdog');
    if (lastDecision.action === 'exit_watchdog') {
      assert.equal(lastDecision.recentErrorCount, 15);
    }
  });

  it('14 errors in 60s does NOT trip watchdog', () => {
    let t = 1_000_000;
    const state = createState({ now: () => t });
    for (let i = 0; i < 14; i++) {
      onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
      t += 1_000;
    }
    assert.ok(
      state.errorTimestamps.length === 14,
      `expected 14 timestamps, got ${state.errorTimestamps.length}`,
    );
  });

  it('errors older than 60s window are evicted', () => {
    let t = 1_000_000;
    const state = createState({ now: () => t });

    // 10 errors at t=1M
    for (let i = 0; i < 10; i++) {
      onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    }
    // Jump 70s ahead
    t += 70_000;
    onPollingError(state, fakeError('boom', 'EAI_AGAIN'));
    assert.equal(
      state.errorTimestamps.length,
      1,
      'older-than-window errors should be pruned',
    );
  });

  it('watchdog fires across mixed transient + non-transient errors', () => {
    let t = 1_000_000;
    const state = createState({ now: () => t });
    let decision: ReturnType<typeof onPollingError> = { action: 'noop' };
    for (let i = 0; i < 15; i++) {
      // Alternate transient and unknown
      const err = i % 2 === 0
        ? fakeError('boom', 'ECONNRESET')
        : new Error('weird thing');
      decision = onPollingError(state, err);
      t += 1_000;
    }
    assert.equal(decision.action, 'exit_watchdog');
  });
});
