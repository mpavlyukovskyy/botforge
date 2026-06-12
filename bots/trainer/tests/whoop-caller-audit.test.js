/**
 * Caller audit (PLAN B3): when the token is dead, every data path degrades
 * quietly — info-level "reauth-pending skip", zero unsolicited messages.
 * The ONE death alert belongs to the token cron; these paths must never
 * become a second spam vector.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'trainer-audit-test-')));

const { ensureDb, getDb, nowSec, runMigrations } = await import('../lib/db.js');
const { fetchAndStoreTodayRecovery, getFreshTodayRecoveryRow } = await import('../lib/recovery-fetch.js');
const dailySync = (await import('../cron/daily-sync.js')).default;

const config = { name: 'AuditTest', platform: { chat_ids: ['5'] } };

function seedDead() {
  const db = getDb(config);
  db.prepare('DELETE FROM oauth_tokens').run();
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, dead_reason, dead_at, last_dead_probe_at)
    VALUES ('whoop', 'AT', 'RT', ?, 'dead', 'invalid_grant', ?, ?)
  `).run(nowSec() - 10, nowSec(), nowSec());
}

beforeAll(() => {
  ensureDb(config);
  runMigrations({ config });
  process.env.WHOOP_CLIENT_ID = 'x';
  process.env.WHOOP_CLIENT_SECRET = 'y';
});

beforeEach(() => {
  seedDead();
  // Any real network call in this file is a test failure.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('unexpected network call while token dead');
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('recovery-fetch with a dead token', () => {
  it('fetchAndStoreTodayRecovery: quiet reauth-pending skip, no warn-spam, no HTTP', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await fetchAndStoreTodayRecovery(config, '2026-06-11', log);
    expect(result.fetched).toBe(false);
    expect(result.reason).toBe('reauth_required');
    expect(log.info.mock.calls.some(c => String(c[0]).includes('reauth-pending skip'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled(); // invalid_grant death → no data HTTP at all
  });

  it('getFreshTodayRecoveryRow falls back to whatever row exists without throwing', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const row = await getFreshTodayRecoveryRow(config, '2026-06-11', log);
    expect(row).toBeNull(); // nothing cached, JIT skipped quietly
  });
});

describe('daily-sync cron with a dead token', () => {
  it('completes without throwing and without sending any message', async () => {
    const ctx = {
      config,
      adapter: { send: vi.fn(async () => {}) },
      store: new Map(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    await dailySync.execute(ctx);
    expect(ctx.adapter.send).not.toHaveBeenCalled();
  });
});
