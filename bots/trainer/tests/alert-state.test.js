/**
 * Alert state machine: one alert per condition, bounded reminders,
 * observation-based emission/recovery, key interplay.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'trainer-alert-test-')));

const { ensureDb, getDb, nowSec, getOAuthToken, runMigrations } = await import('../lib/db.js');
const {
  ALERT_KEYS, ensureAlert, clearWithRecovery, readAlertKey, clearAlertKey,
  sweepWhoopAlerts, transientOutageCheck, configErrorAlert,
} = await import('../lib/alert-state.js');

const config = { name: 'AlertTest', platform: { chat_ids: ['42'] } };

function makeCtx() {
  return {
    config,
    adapter: { send: vi.fn(async () => {}) },
    store: new Map(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function seedRow(overrides = {}) {
  const db = getDb(config);
  db.prepare('DELETE FROM oauth_tokens').run();
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, dead_reason, dead_at, first_transient_failure_at)
    VALUES ('whoop', 'AT', @refresh_token, @expires_at, @status, @dead_reason, @dead_at, @first_transient_failure_at)
  `).run({
    refresh_token: 'RT',
    expires_at: nowSec() + 3600,
    status: 'active',
    dead_reason: null,
    dead_at: null,
    first_transient_failure_at: null,
    ...overrides,
  });
  return getOAuthToken(config, 'whoop');
}

beforeAll(() => {
  ensureDb(config);
  runMigrations({ config }); // bot_state lives in the start-hook migrations
});
beforeEach(() => {
  getDb(config).prepare("DELETE FROM bot_state WHERE key LIKE 'whoop_%'").run();
  seedRow();
});
afterEach(() => vi.useRealTimers());

describe('ensureAlert dedup + reminder cadence', () => {
  it('sends once, dedups immediately after, reminds at +6h, +24h, then daily', async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();

    expect(await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG')).toBe('alerted');
    expect(await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG')).toBe('deduped');
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 6 * 3600_000 + 1000);
    expect(await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG')).toBe('reminded');

    vi.setSystemTime(Date.now() + 10 * 3600_000); // +16h total — second reminder at set+24h not yet due
    expect(await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG')).toBe('deduped');

    vi.setSystemTime(Date.now() + 9 * 3600_000); // +25h total
    expect(await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG')).toBe('reminded');

    vi.setSystemTime(Date.now() + 23 * 3600_000); // +48h: daily cadence
    expect(await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG')).toBe('deduped'); // 23h since last < 24h
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    expect(await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG')).toBe('reminded');

    expect(ctx.adapter.send).toHaveBeenCalledTimes(4); // 1 alert + 3 reminders
  });

  it('clearWithRecovery sends the recovery notice only when the key was set', async () => {
    const ctx = makeCtx();
    expect(await clearWithRecovery(ctx, ALERT_KEYS.dead)).toBe(false);
    expect(ctx.adapter.send).not.toHaveBeenCalled();
    await ensureAlert(ctx, ALERT_KEYS.dead, 'MSG');
    expect(await clearWithRecovery(ctx, ALERT_KEYS.dead)).toBe(true);
    expect(readAlertKey(config, ALERT_KEYS.dead)).toBeNull();
    expect(ctx.adapter.send).toHaveBeenCalledTimes(2);
    expect(ctx.adapter.send.mock.calls[1][0].text).toContain('recovered');
  });
});

describe('sweepWhoopAlerts (observation-based)', () => {
  it('dead row + no key → ONE death alert with the re-auth command; transient key cleared silently', async () => {
    const ctx = makeCtx();
    // An open transient episode that death supersedes:
    await ensureAlert(ctx, ALERT_KEYS.transient, 'transient blah');
    ctx.adapter.send.mockClear();

    const row = seedRow({ status: 'dead', dead_reason: 'invalid_grant', dead_at: nowSec() });
    await sweepWhoopAlerts(ctx, row);
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    const text = ctx.adapter.send.mock.calls[0][0].text;
    expect(text).toContain('DEAD');
    expect(text).toContain('whoop-reauth');
    expect(text).toContain('without recovery data');
    expect(readAlertKey(config, ALERT_KEYS.transient)).toBeNull(); // no double-nag, no bogus recovery

    // Second sweep: deduped.
    await sweepWhoopAlerts(ctx, row);
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('death marked by ANOTHER process still alerts on the next sweep (emission is not transition-located)', async () => {
    const ctx = makeCtx();
    // Simulate whoop-backfill.js marking death through its own connection.
    getDb(config).prepare("UPDATE oauth_tokens SET status='dead', dead_reason='invalid_request_x3', dead_at=? WHERE provider='whoop'")
      .run(nowSec());
    await sweepWhoopAlerts(ctx, getOAuthToken(config, 'whoop'));
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    expect(ctx.adapter.send.mock.calls[0][0].text).toContain('DEAD');
  });

  it('active row + dead key set (SSH re-auth revival) → recovery message, all keys cleared', async () => {
    const ctx = makeCtx();
    await ensureAlert(ctx, ALERT_KEYS.dead, 'dead msg');
    await ensureAlert(ctx, ALERT_KEYS.config, 'config msg');
    ctx.adapter.send.mockClear();

    const row = seedRow({ status: 'active' });
    await sweepWhoopAlerts(ctx, row);
    expect(readAlertKey(config, ALERT_KEYS.dead)).toBeNull();
    expect(readAlertKey(config, ALERT_KEYS.config)).toBeNull();
    const texts = ctx.adapter.send.mock.calls.map(c => c[0].text);
    expect(texts.some(t => t.includes('recovered'))).toBe(true);
  });

  it('transient key clears only once the row window stamp is reset (a real success happened)', async () => {
    const ctx = makeCtx();
    await ensureAlert(ctx, ALERT_KEYS.transient, 'outage');
    ctx.adapter.send.mockClear();

    // Still failing: active row but window open → key stays.
    let row = seedRow({ status: 'active', first_transient_failure_at: nowSec() - 3 * 3600 });
    await sweepWhoopAlerts(ctx, row);
    expect(readAlertKey(config, ALERT_KEYS.transient)).not.toBeNull();

    // Success CAS nulls the stamp → recovery notice.
    row = seedRow({ status: 'active', first_transient_failure_at: null });
    await sweepWhoopAlerts(ctx, row);
    expect(readAlertKey(config, ALERT_KEYS.transient)).toBeNull();
    expect(ctx.adapter.send.mock.calls.some(c => c[0].text.includes('Whoop API recovered'))).toBe(true);
  });

  it('no row → never-authorized alert (once), naming the re-auth command', async () => {
    const ctx = makeCtx();
    getDb(config).prepare('DELETE FROM oauth_tokens').run();
    await sweepWhoopAlerts(ctx, null);
    await sweepWhoopAlerts(ctx, null);
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    expect(ctx.adapter.send.mock.calls[0][0].text).toContain('whoop-reauth');
  });
});

describe('transientOutageCheck', () => {
  it('quiet under 2h, one alert with the raw error after 2h, deduped after', async () => {
    const ctx = makeCtx();
    let row = seedRow({ first_transient_failure_at: nowSec() - 3600 });
    await transientOutageCheck(ctx, row, 'HTTP 503 cloudflare');
    expect(ctx.adapter.send).not.toHaveBeenCalled();

    row = seedRow({ first_transient_failure_at: nowSec() - 2 * 3600 - 60 });
    await transientOutageCheck(ctx, row, 'HTTP 503 cloudflare');
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    expect(ctx.adapter.send.mock.calls[0][0].text).toContain('HTTP 503 cloudflare');

    await transientOutageCheck(ctx, row, 'HTTP 503 cloudflare');
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
  });
});

describe('configErrorAlert', () => {
  it('its own key + actionable text, no re-auth instruction, deduped', async () => {
    const ctx = makeCtx();
    await configErrorAlert(ctx, 'invalid_client');
    await configErrorAlert(ctx, 'invalid_client');
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    const text = ctx.adapter.send.mock.calls[0][0].text;
    expect(text).toContain('WHOOP_CLIENT_ID');
    expect(text).toContain('NOT fix');
    expect(readAlertKey(config, ALERT_KEYS.config)).not.toBeNull();
  });
});
