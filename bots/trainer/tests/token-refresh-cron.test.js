/**
 * token_refresh cron handler: three INDEPENDENT sections. A dead Whoop token
 * must not stop Hevy polling or Telegram offset persistence, and log states
 * must be truthful (no phantom "refreshed").
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'trainer-cron-test-')));

const { ensureDb, getDb, nowSec, runMigrations, getState, getOAuthToken } = await import('../lib/db.js');
const cron = (await import('../cron/token-refresh.js')).default;

const config = { name: 'CronTest', platform: { chat_ids: ['99'] } };

function makeCtx() {
  return {
    config,
    adapter: { send: vi.fn(async () => {}), getPollingOffset: () => 12345 },
    store: new Map(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function logLines(ctx) {
  return ['info', 'warn', 'error'].flatMap(l => ctx.log[l].mock.calls.map(c => c[0]));
}

function seedRow(overrides = {}) {
  const db = getDb(config);
  db.prepare('DELETE FROM oauth_tokens').run();
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, dead_reason, dead_at, last_dead_probe_at)
    VALUES ('whoop', 'AT', @refresh_token, @expires_at, @status, @dead_reason, @dead_at, @last_dead_probe_at)
  `).run({
    refresh_token: 'RT',
    expires_at: nowSec() + 3600,
    status: 'active',
    dead_reason: null,
    dead_at: null,
    last_dead_probe_at: null,
    ...overrides,
  });
}

beforeAll(() => {
  ensureDb(config);
  runMigrations({ config });
  process.env.WHOOP_CLIENT_ID = 'test-client';
  process.env.WHOOP_CLIENT_SECRET = 'test-secret';
  process.env.HEVY_API_KEY = 'test-hevy-key';
});

beforeEach(() => {
  getDb(config).prepare('DELETE FROM bot_state').run();
  seedRow();
  // Hevy API responds empty by default; token endpoint never hit unless a test wants it.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ events: [], page: 1, page_count: 1 }),
    text: async () => '{}',
  })));
});
afterEach(() => vi.unstubAllGlobals());

describe('section independence under a dead token', () => {
  it('dead-skip applies ONLY to the Whoop section — Hevy poll + offset persistence still run', async () => {
    seedRow({ status: 'dead', dead_reason: 'invalid_grant', dead_at: nowSec(), last_dead_probe_at: nowSec() });
    const ctx = makeCtx();
    await cron.execute(ctx);

    const lines = logLines(ctx);
    expect(lines.some(l => l.includes('dead-skip'))).toBe(true);
    expect(lines.some(l => l.includes('hevy-poll ok'))).toBe(true);
    expect(getState(config, 'last_events_since')).toBeTruthy();
    expect(getState(config, 'telegram_polling_offset')).toBe('12345');
  });

  it('exactly ONE death alert on the first tick, zero on subsequent ticks', async () => {
    seedRow({ status: 'dead', dead_reason: 'invalid_grant', dead_at: nowSec(), last_dead_probe_at: nowSec() });
    const ctx = makeCtx();
    await cron.execute(ctx);
    await cron.execute(ctx);
    await cron.execute(ctx);
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    expect(ctx.adapter.send.mock.calls[0][0].text).toContain('DEAD');
  });

  it('no token-endpoint HTTP while dead inside the 12h probe window', async () => {
    seedRow({ status: 'dead', dead_reason: 'invalid_request_x3', dead_at: nowSec(), last_dead_probe_at: nowSec(), expires_at: nowSec() - 10 });
    const ctx = makeCtx();
    await cron.execute(ctx);
    const tokenCalls = globalThis.fetch.mock.calls.filter(c => String(c[0]).includes('oauth2/token'));
    expect(tokenCalls).toHaveLength(0);
  });
});

describe('truthful log states', () => {
  it('valid-skip when the token has plenty of life — and never logs "refreshed"', async () => {
    const ctx = makeCtx();
    await cron.execute(ctx);
    const lines = logLines(ctx);
    expect(lines.some(l => l.includes('whoop: valid-skip'))).toBe(true);
    expect(lines.some(l => l.includes('refreshed'))).toBe(false);
  });

  it('"refreshed" only on a real, persisted refresh', async () => {
    seedRow({ expires_at: nowSec() + 100 });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('oauth2/token')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ events: [], page: 1, page_count: 1 }) };
    }));
    const ctx = makeCtx();
    await cron.execute(ctx);
    expect(logLines(ctx).some(l => l.includes('whoop: refreshed'))).toBe(true);
    expect(getOAuthToken(config, 'whoop').refresh_token).toBe('RT2');
  });

  it('no-token-skip when never authorized — alerts once, never throws', async () => {
    getDb(config).prepare('DELETE FROM oauth_tokens').run();
    const ctx = makeCtx();
    await cron.execute(ctx);
    await cron.execute(ctx);
    expect(logLines(ctx).filter(l => l.includes('no-token-skip')).length).toBe(2);
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1); // never-authorized alert, deduped
  });

  it('config-error: alerted with env guidance, token NOT marked dead', async () => {
    seedRow({ expires_at: nowSec() + 100 });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('oauth2/token')) {
        return { ok: false, status: 401, text: async () => '{"error":"invalid_client"}' };
      }
      return { ok: true, status: 200, json: async () => ({ events: [], page: 1, page_count: 1 }) };
    }));
    const ctx = makeCtx();
    await cron.execute(ctx);
    expect(logLines(ctx).some(l => l.includes('config-error'))).toBe(true);
    expect(getOAuthToken(config, 'whoop').status).toBe('active');
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    expect(ctx.adapter.send.mock.calls[0][0].text).toContain('WHOOP_CLIENT_ID');
  });
});

describe('recovery after SSH re-auth', () => {
  it('next tick observes the revived row and sends the recovery message (no restart)', async () => {
    seedRow({ status: 'dead', dead_reason: 'invalid_grant', dead_at: nowSec(), last_dead_probe_at: nowSec() });
    const ctx = makeCtx();
    await cron.execute(ctx); // death alert
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);

    // whoop-reauth.mjs installs a fresh chain directly in the DB:
    getDb(config).prepare(`
      UPDATE oauth_tokens SET access_token='ATre', refresh_token='RTre', expires_at=?,
        status='active', dead_reason=NULL, dead_at=NULL, consecutive_invalid_request=0,
        first_transient_failure_at=NULL, last_dead_probe_at=NULL
      WHERE provider='whoop'
    `).run(nowSec() + 3600);

    await cron.execute(ctx);
    expect(ctx.adapter.send).toHaveBeenCalledTimes(2);
    expect(ctx.adapter.send.mock.calls[1][0].text).toContain('recovered');
    expect(logLines(ctx).some(l => l.includes('whoop: valid-skip'))).toBe(true);
  });
});
