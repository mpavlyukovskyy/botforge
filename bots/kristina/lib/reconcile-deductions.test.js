/**
 * S2: a deduction reversed (or contested) on the dashboard must reach the bot's
 * local balance. reconcileDeductions pulls Atlas (?all=1) and converges the
 * local deductions table's reversed_at/contested_at. Only deductions the bot
 * tracks locally are touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconcileDeductions, ensureDb, __resetDbForTests } from './atlas-client.js';
import { rmSync } from 'node:fs';

const NAME = 'rdtest';
const ctx = {
  config: { name: NAME, integrations: { atlas: { url: 'http://x', token: 't' } } },
  log: { warn() {}, info() {} },
};

function db() { return ensureDb(ctx.config); }
function mockFetch(deductions) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ deductions }) })));
}

beforeEach(() => {
  __resetDbForTests();
  try { rmSync(`data/${NAME}-tools.db`, { force: true }); } catch {}
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS deductions (id TEXT PRIMARY KEY, amount REAL, reason TEXT,
    requester TEXT, requester_chat_id TEXT, billing_month TEXT, created_at TEXT, reversed_at TEXT,
    contested_at TEXT, contest_note TEXT);`);
});
afterEach(() => {
  __resetDbForTests();
  try { rmSync(`data/${NAME}-tools.db`, { force: true }); } catch {}
  vi.unstubAllGlobals();
});

describe('reconcileDeductions', () => {
  it('propagates a dashboard reversal into the local row', async () => {
    db().prepare("INSERT INTO deductions (id, amount, reason, billing_month) VALUES ('d1', 0.1, 'no update', '2026-06')").run();
    mockFetch([{ id: 'd1', reversedAt: '2026-06-10T00:00:00Z', contestedAt: null, contestNote: null }]);
    const changed = await reconcileDeductions(ctx);
    expect(changed).toBe(1);
    expect(db().prepare("SELECT reversed_at FROM deductions WHERE id='d1'").get().reversed_at).toBe('2026-06-10T00:00:00Z');
  });

  it('propagates a contest (contestedAt + note)', async () => {
    db().prepare("INSERT INTO deductions (id, amount, reason, billing_month) VALUES ('d2', 0.1, 'x', '2026-06')").run();
    mockFetch([{ id: 'd2', reversedAt: null, contestedAt: '2026-06-10T01:00:00Z', contestNote: 'was on PTO' }]);
    const changed = await reconcileDeductions(ctx);
    expect(changed).toBe(1);
    const r = db().prepare("SELECT contested_at, contest_note FROM deductions WHERE id='d2'").get();
    expect(r.contested_at).toBe('2026-06-10T01:00:00Z');
    expect(r.contest_note).toBe('was on PTO');
  });

  it('ignores Atlas deductions the bot does not track locally', async () => {
    mockFetch([{ id: 'unknown', reversedAt: '2026-06-10T00:00:00Z' }]);
    const changed = await reconcileDeductions(ctx);
    expect(changed).toBe(0);
  });

  it('no-op when nothing changed (idempotent)', async () => {
    db().prepare("INSERT INTO deductions (id, amount, reason, billing_month, reversed_at) VALUES ('d3', 0.1, 'x', '2026-06', '2026-06-10T00:00:00Z')").run();
    mockFetch([{ id: 'd3', reversedAt: '2026-06-10T00:00:00Z' }]);
    expect(await reconcileDeductions(ctx)).toBe(0);
  });

  it('returns null when Atlas fetch fails (unverifiable)', async () => {
    db().prepare("INSERT INTO deductions (id, amount, reason, billing_month) VALUES ('d4', 0.1, 'x', '2026-06')").run();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect(await reconcileDeductions(ctx)).toBeNull();
  });
});
