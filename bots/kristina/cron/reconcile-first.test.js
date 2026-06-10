/**
 * Phase 0: financial/destructive crons reconcile to Atlas truth FIRST and skip
 * the run only on an explicit reconcile abort (Atlas unverifiable). A 'skipped'
 * result (another reconcile running / disabled) must NOT skip — it falls through
 * to the presence-guard backstop. Regression guard for red-team D3.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let reconcileResult;
let presenceSkip; // what shouldSkipRun returns
const sqlAll = vi.fn(() => []);

vi.mock('../lib/sync.js', () => ({ reconcile: async () => reconcileResult }));
vi.mock('../lib/presence.js', () => ({
  loadAtlasPresence: async () => ({ enabled: true, available: true, skip: () => false }),
  shouldSkipRun: () => presenceSkip,
}));
vi.mock('../lib/atlas-client.js', () => ({
  ensureDb: () => ({ prepare: () => ({ all: sqlAll, get: () => undefined, run: () => {} }) }),
  updateItem: async () => true,
  syncDeduction: async () => true,
}));

const decayCheck = (await import('./decay-check.js')).default;
const deadlineExpiry = (await import('./deadline-expiry.js')).default;

const ctx = { config: { name: 'test', behavior: {} }, log: { info() {}, warn() {}, error() {}, debug() {} }, adapter: { send: async () => {} } };

beforeEach(() => { reconcileResult = { ok: true, reaped: 0 }; presenceSkip = false; sqlAll.mockClear(); });

describe('reconcile-first in financial crons', () => {
  it('decay_check SKIPS the run when reconcile aborts (no task query)', async () => {
    reconcileResult = { aborted: 'atlas-unverifiable' };
    await decayCheck.execute(ctx);
    expect(sqlAll).not.toHaveBeenCalled(); // never reached the task select
  });

  it('decay_check PROCEEDS to task work on a clean reconcile', async () => {
    reconcileResult = { ok: true };
    await decayCheck.execute(ctx);
    expect(sqlAll).toHaveBeenCalled(); // reached the task select
  });

  it("decay_check does NOT skip on reconcile 'skipped' (falls through to presence backstop)", async () => {
    reconcileResult = { skipped: 'already-running' };
    presenceSkip = false;
    await decayCheck.execute(ctx);
    expect(sqlAll).toHaveBeenCalled(); // proceeded (presence didn't block)
  });

  it('decay_check still skips when reconcile is fine but presence backstop says unverifiable', async () => {
    reconcileResult = { ok: true };
    presenceSkip = true;
    await decayCheck.execute(ctx);
    expect(sqlAll).not.toHaveBeenCalled();
  });

  it('deadline_expiry skips on reconcile abort', async () => {
    reconcileResult = { aborted: 'suspect-empty' };
    await deadlineExpiry.execute(ctx);
    expect(sqlAll).not.toHaveBeenCalled();
  });
});
