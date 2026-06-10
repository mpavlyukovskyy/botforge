import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CallbackIdempotency, withCallbackIdempotency } from './callback-idempotency.js';

describe('CallbackIdempotency', () => {
  it('first call wraps and returns the work result', async () => {
    const idem = new CallbackIdempotency();
    const result = await idem.wrap('q-1', async () => 'ok');
    assert.equal(result, 'ok');
  });

  it('second call with same queryId returns skipped without running work', async () => {
    const idem = new CallbackIdempotency();
    let runs = 0;
    await idem.wrap('q-2', async () => { runs++; });
    const second = await idem.wrap('q-2', async () => { runs++; });
    assert.equal(runs, 1, 'work should have run exactly once');
    assert.ok(typeof second === 'object' && 'skipped' in second && second.skipped === 'duplicate');
  });

  it('different queryIds do not interfere', async () => {
    const idem = new CallbackIdempotency();
    let runs = 0;
    await idem.wrap('q-A', async () => { runs++; });
    await idem.wrap('q-B', async () => { runs++; });
    assert.equal(runs, 2);
  });

  it('TTL expiry allows a re-tap to process again', async () => {
    let now = 0;
    const idem = new CallbackIdempotency({ ttlMs: 100, now: () => now });
    let runs = 0;
    await idem.wrap('q-ttl', async () => { runs++; });
    now += 1000; // 1 second later — past TTL
    await idem.wrap('q-ttl', async () => { runs++; });
    assert.equal(runs, 2);
  });

  it('size reflects active entries within TTL', async () => {
    let now = 0;
    const idem = new CallbackIdempotency({ ttlMs: 100, now: () => now });
    await idem.wrap('q-1', async () => {});
    await idem.wrap('q-2', async () => {});
    assert.equal(idem.size(), 2);
    now += 1000;
    // gc fires on next access
    idem.wrap('q-3', async () => {});
    assert.equal(idem.size(), 1, 'expired entries swept on access');
  });

  it('concurrent same-queryId: second call sees the first as in-flight', async () => {
    const idem = new CallbackIdempotency();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const first = idem.wrap('q-conc', async () => { await slow; return 'first'; });
    const second = await idem.wrap('q-conc', async () => 'second');
    assert.ok(typeof second === 'object' && 'skipped' in second);
    release();
    assert.equal(await first, 'first');
  });

  it('check() returns duplicate without claiming the queryId', async () => {
    const idem = new CallbackIdempotency();
    await idem.wrap('q-x', async () => {});
    const c = idem.check('q-x');
    assert.equal(c.kind, 'duplicate');
    if (c.kind === 'duplicate') assert.ok(typeof c.firstSeenAt === 'number');
  });

  it('withCallbackIdempotency convenience wraps the module-level singleton', async () => {
    let runs = 0;
    await withCallbackIdempotency('q-singleton-1', async () => { runs++; });
    const second = await withCallbackIdempotency('q-singleton-1', async () => { runs++; });
    assert.equal(runs, 1);
    assert.ok(typeof second === 'object' && second !== null && 'skipped' in second);
  });
});
