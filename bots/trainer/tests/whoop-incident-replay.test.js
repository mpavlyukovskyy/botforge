/**
 * THE regression test for the 2026-06-11 incident
 * (docs/RCA-whoop-token-spam-2026-06-11.md): healthy refresh → Cloudflare
 * 503 outage window → permanent 400 invalid_request. The old code sent 267
 * identical Telegram alerts in 24h. The hardened pipeline must produce
 * exactly ONE death alert, with truthful states throughout.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'trainer-replay-test-')));

const { ensureDb, getDb, nowSec, runMigrations, getOAuthToken } = await import('../lib/db.js');
const cron = (await import('../cron/token-refresh.js')).default;

const config = { name: 'ReplayTest', platform: { chat_ids: ['7'] } };

const CF_503 = '<html><head><title>503 Service Temporarily Unavailable</title></head><body>nginx</body></html>';
const INVALID_REQUEST = JSON.stringify({
  error: 'invalid_request',
  error_description: 'The request is missing a required parameter, includes an invalid parameter value, includes a parameter more than once, or is otherwise malformed',
  error_hint: 'Make sure that the various parameters are correct, be aware of case sensitivity and trim your parameters. Make sure that the client you are using has exactly whitelisted the redirect_uri you specified.',
  status_code: 400,
});

beforeAll(() => {
  ensureDb(config);
  runMigrations({ config });
  process.env.WHOOP_CLIENT_ID = 'test-client';
  process.env.WHOOP_CLIENT_SECRET = 'test-secret';
  delete process.env.HEVY_API_KEY; // keep the replay focused on the Whoop section
});

it('Jun-10 incident sequence → exactly ONE alert, dead after 3×400, truthful states', async () => {
  const db = getDb(config);
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status)
    VALUES ('whoop', 'AT0', 'RT0', ?, 'active')
  `).run(nowSec() + 100); // expiring → every tick attempts a refresh

  // Scripted Whoop responses: 1 success, 6 Cloudflare 503s, then 400 forever.
  const responses = [];
  responses.push({ ok: true, status: 200, body: JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 100 }) });
  for (let i = 0; i < 6; i++) responses.push({ ok: false, status: 503, body: CF_503 });
  const tokenFetch = vi.fn(async () => {
    const r = responses.shift() || { ok: false, status: 400, body: INVALID_REQUEST };
    return { ok: r.ok, status: r.status, text: async () => r.body };
  });
  vi.stubGlobal('fetch', tokenFetch);

  const ctx = {
    config,
    adapter: { send: vi.fn(async () => {}) },
    store: new Map(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const counterTrajectory = [];
  const statusTrajectory = [];

  // 24 five-minute ticks ≈ 2 hours of the incident.
  for (let tick = 0; tick < 24; tick++) {
    await cron.execute(ctx);
    const row = getOAuthToken(config, 'whoop');
    counterTrajectory.push(row.consecutive_invalid_request);
    statusTrajectory.push(row.status);
    // Keep the token "expiring" so each tick re-attempts (the real incident's
    // expires_at was in the past throughout).
    if (row.status === 'active') {
      db.prepare("UPDATE oauth_tokens SET expires_at=? WHERE provider='whoop'").run(nowSec() + 100);
    }
  }

  // Tick 1: real success. Ticks 2-7: 503s (counter untouched, no alert —
  // window < 2h). Ticks 8-10: 400s counting 1,2,3 → dead. Ticks 11+: dead-skip.
  expect(statusTrajectory[0]).toBe('active');
  expect(counterTrajectory.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  expect(counterTrajectory[7]).toBe(1);
  expect(counterTrajectory[8]).toBe(2);
  expect(counterTrajectory[9]).toBe(3);
  expect(statusTrajectory[8]).toBe('active');
  expect(statusTrajectory[9]).toBe('dead');
  expect(statusTrajectory[23]).toBe('dead');

  // THE invariant the incident violated: exactly one Mark-facing message.
  expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
  const text = ctx.adapter.send.mock.calls[0][0].text;
  expect(text).toContain('DEAD');
  expect(text).toContain('whoop-reauth');

  // After death: no further token-endpoint HTTP (probe anchored at dead_at+12h).
  const callsAtDeath = tokenFetch.mock.calls.length;
  expect(callsAtDeath).toBe(10); // 1 success + 6×503 + 3×400
  const row = getOAuthToken(config, 'whoop');
  expect(row.dead_reason).toBe('invalid_request_x3');
  expect(row.last_dead_probe_at).toBe(row.dead_at);

  // Truthful logging: "refreshed" appeared exactly once (the real success).
  const infoLines = ctx.log.info.mock.calls.map(c => c[0]);
  expect(infoLines.filter(l => l === 'whoop: refreshed')).toHaveLength(1);
  expect(infoLines.filter(l => l.includes('dead-skip')).length).toBeGreaterThanOrEqual(13);
});
