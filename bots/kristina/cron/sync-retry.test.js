/**
 * Tests for the sync_retry reconcile-alerting (standing liveness check).
 * Proves Mark is alerted when reconcile persistently aborts (Atlas down) or
 * reaps suspiciously many rows, and that recovery is announced.
 * Re-imports the cron per test so its module-level counters start fresh.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let reconcileResult = { ok: true, reaped: 0 };
vi.mock('../lib/sync.js', () => ({ reconcile: async () => reconcileResult }));
vi.mock('../lib/atlas-client.js', () => ({ retrySyncPending: async () => 0 }));

let sent;
const ctx = {
  config: { behavior: { access: { admin_users: ['12345'] } } },
  adapter: { send: async (m) => { sent.push(m); } },
  log: { info() {}, warn() {}, error() {} },
};

async function freshCron() {
  vi.resetModules();
  return (await import('./sync-retry.js')).default;
}

beforeEach(() => { sent = []; reconcileResult = { ok: true, reaped: 0 }; });

describe('sync_retry alerting', () => {
  it('alerts after 3 consecutive reconcile aborts, only once', async () => {
    const cron = await freshCron();
    reconcileResult = { aborted: 'atlas-unverifiable' };
    await cron.execute(ctx);
    await cron.execute(ctx);
    expect(sent.length).toBe(0);
    await cron.execute(ctx); // 3rd → alert
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/aborting/i);
    await cron.execute(ctx); // no duplicate
    expect(sent.length).toBe(1);
  });

  it('announces recovery after an abort episode', async () => {
    const cron = await freshCron();
    reconcileResult = { aborted: 'atlas-unverifiable' };
    for (let i = 0; i < 3; i++) await cron.execute(ctx);
    expect(sent.length).toBe(1);
    reconcileResult = { ok: true, reaped: 0 };
    await cron.execute(ctx);
    expect(sent.length).toBe(2);
    expect(sent[1].text).toMatch(/recovered/i);
  });

  it('alerts on a suspiciously large reap', async () => {
    const cron = await freshCron();
    reconcileResult = { ok: true, reaped: 40, snapshot: 100 };
    await cron.execute(ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/reaped 40/);
  });

  it('does NOT alert on a normal small reap', async () => {
    const cron = await freshCron();
    reconcileResult = { ok: true, reaped: 5, snapshot: 300 };
    await cron.execute(ctx);
    expect(sent.length).toBe(0);
  });
});
