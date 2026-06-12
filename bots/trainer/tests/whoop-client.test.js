/**
 * Token-manager tests: error taxonomy (total function, transient default),
 * the refresh critical section, CAS persistence, and dead-state semantics.
 * Real better-sqlite3 (temp dir), mocked global fetch.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'trainer-client-test-')));

const {
  ensureDb, getDb, nowSec, getOAuthToken,
} = await import('../lib/db.js');
const {
  getAccessToken, refreshAccessToken, classifyRefreshFailure, getRecovery,
  ReauthRequiredError, RefreshUnavailableError, WhoopConfigError, WhoopTransientError,
} = await import('../lib/whoop-client.js');

const config = { name: 'ClientTest' };

const CF_HTML = '<html><head><title>503 Service Temporarily Unavailable</title></head></html>';
const INVALID_REQUEST_BODY = JSON.stringify({
  error: 'invalid_request',
  error_description: 'The request is missing a required parameter...',
  error_hint: 'Make sure that the client you are using has exactly whitelisted the redirect_uri you specified.',
  status_code: 400,
});

function seed(overrides = {}) {
  const db = getDb(config);
  db.prepare('DELETE FROM oauth_tokens').run();
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, dead_reason, dead_at, consecutive_invalid_request, last_dead_probe_at)
    VALUES ('whoop', @access_token, @refresh_token, @expires_at, @status, @dead_reason, @dead_at, @consecutive_invalid_request, @last_dead_probe_at)
  `).run({
    access_token: 'AT1',
    refresh_token: 'RT1',
    expires_at: nowSec() + 100, // inside the 5-min margin → refresh wanted
    status: 'active',
    dead_reason: null,
    dead_at: null,
    consecutive_invalid_request: 0,
    last_dead_probe_at: null,
    ...overrides,
  });
}

function mockFetchResponse(status, body) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
}

function successBody(n = 2) {
  return JSON.stringify({
    access_token: `AT${n}`, refresh_token: `RT${n}`, expires_in: 3600,
    scope: 'offline read:recovery read:sleep read:cycles read:profile read:workout',
  });
}

beforeAll(() => {
  ensureDb(config);
  process.env.WHOOP_CLIENT_ID = 'test-client';
  process.env.WHOOP_CLIENT_SECRET = 'test-secret';
});

beforeEach(() => seed());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Taxonomy (pure function) ───────────────────────────────────────────────

describe('classifyRefreshFailure — total function, transient default', () => {
  const cases = [
    [503, CF_HTML, 'transient'],
    [429, '{"error":"rate_limited"}', 'transient'],
    [403, '<html>cloudflare challenge</html>', 'transient'],
    [400, '<html>not json</html>', 'transient'],
    [400, '{"error":"invalid_req', 'transient'], // truncated JSON
    [500, '', 'transient'],
    [400, '{"error":"some_future_code"}', 'transient'],
    [401, '{"error":"invalid_client"}', 'config'],
    [400, '{"error":"invalid_client"}', 'config'],
    [400, '{"error":"unauthorized_client"}', 'config'],
    [400, '{"error":"invalid_grant"}', 'invalid_grant'],
    [400, INVALID_REQUEST_BODY, 'invalid_request'],
    [400, '{"error":"invalid_request","error_description":"Failed to refresh token because of multiple concurrent requests using the same token"}', 'transient'],
    [400, '{"error":"invalid_request","error_description":"Failed to refresh token. Please retry the request."}', 'transient'],
  ];
  it.each(cases)('HTTP %s %s → %s', (status, body, expected) => {
    expect(classifyRefreshFailure(status, body).class).toBe(expected);
  });
});

// ─── Refresh paths ──────────────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  it('missing client env → WhoopConfigError before any HTTP', async () => {
    const f = mockFetchResponse(200, successBody());
    vi.stubGlobal('fetch', f);
    const saved = process.env.WHOOP_CLIENT_ID;
    delete process.env.WHOOP_CLIENT_ID;
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(WhoopConfigError);
    expect(f).not.toHaveBeenCalled();
    process.env.WHOOP_CLIENT_ID = saved;
  });

  it('success: persists new tokens before returning, resets state, releases the lock', async () => {
    getDb(config).prepare("UPDATE oauth_tokens SET consecutive_invalid_request=2, first_transient_failure_at=5 WHERE provider='whoop'").run();
    vi.stubGlobal('fetch', mockFetchResponse(200, successBody(2)));
    const at = await refreshAccessToken(config);
    expect(at).toBe('AT2');
    const row = getOAuthToken(config, 'whoop');
    expect(row.refresh_token).toBe('RT2');
    expect(row.consecutive_invalid_request).toBe(0);
    expect(row.first_transient_failure_at).toBeNull();
    expect(row.lock_token).toBeNull();
    expect(row.expires_at).toBeGreaterThan(nowSec() + 3000);
  });

  it('invalid_grant → token marked dead (CAS) + ReauthRequiredError', async () => {
    vi.stubGlobal('fetch', mockFetchResponse(400, '{"error":"invalid_grant"}'));
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(ReauthRequiredError);
    const row = getOAuthToken(config, 'whoop');
    expect(row.status).toBe('dead');
    expect(row.dead_reason).toBe('invalid_grant');
    expect(row.last_dead_probe_at).toBe(row.dead_at);
    expect(row.lock_token).toBeNull(); // finally released
  });

  it('generic invalid_request: transient ×2 with counter, dead on the 3rd', async () => {
    vi.stubGlobal('fetch', mockFetchResponse(400, INVALID_REQUEST_BODY));
    for (const expectedCount of [1, 2]) {
      const err = await refreshAccessToken(config).catch(e => e);
      expect(err).toBeInstanceOf(WhoopTransientError);
      expect(err.invalidRequestCount).toBe(expectedCount);
      expect(getOAuthToken(config, 'whoop').status).toBe('active');
    }
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(getOAuthToken(config, 'whoop').status).toBe('dead');
    expect(getOAuthToken(config, 'whoop').dead_reason).toBe('invalid_request_x3');
  });

  it('transient 503 between invalid_requests neither increments nor resets the counter', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => INVALID_REQUEST_BODY })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => INVALID_REQUEST_BODY })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => CF_HTML })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => INVALID_REQUEST_BODY });
    vi.stubGlobal('fetch', f);
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(WhoopTransientError); // 1
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(WhoopTransientError); // 2
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(WhoopTransientError); // 503: counter stays 2
    expect(getOAuthToken(config, 'whoop').consecutive_invalid_request).toBe(2);
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(ReauthRequiredError); // 3 → dead
    expect(getOAuthToken(config, 'whoop').status).toBe('dead');
  });

  it('5xx/network failures stamp first_transient_failure_at and never touch the stored token', async () => {
    vi.stubGlobal('fetch', mockFetchResponse(503, CF_HTML));
    await expect(refreshAccessToken(config)).rejects.toBeInstanceOf(WhoopTransientError);
    const row = getOAuthToken(config, 'whoop');
    expect(row.refresh_token).toBe('RT1');
    expect(row.status).toBe('active');
    expect(row.first_transient_failure_at).toBeGreaterThan(0);
  });

  it('stale success cannot overwrite a token rotated mid-flight (CAS mismatch → newer token returned)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      // Re-auth installs a brand-new chain while our request is in flight.
      getDb(config).prepare("UPDATE oauth_tokens SET access_token='ATnew', refresh_token='RTnew', expires_at=? WHERE provider='whoop'")
        .run(nowSec() + 3600);
      return { ok: true, status: 200, text: async () => successBody(9) };
    }));
    const at = await refreshAccessToken(config);
    expect(at).toBe('ATnew'); // the newer chain wins; our stale result is discarded
    expect(getOAuthToken(config, 'whoop').refresh_token).toBe('RTnew');
  });

  it('a success landing late (no steal) is still persisted — no wall-clock discard', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => {
      vi.setSystemTime(Date.now() + 100_000); // response lands 100s after lock acquisition
      return { ok: true, status: 200, text: async () => successBody(3) };
    }));
    const at = await refreshAccessToken(config);
    expect(at).toBe('AT3');
    expect(getOAuthToken(config, 'whoop').refresh_token).toBe('RT3');
  });

  it('slow body: abort covers the full body read — transient, nothing persisted', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((url, opts) => Promise.resolve({
      ok: true,
      status: 200,
      // Body trickles forever; only the abort signal ends it.
      text: () => new Promise((_, rej) => {
        opts.signal.addEventListener('abort', () =>
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    })));
    const pending = refreshAccessToken(config);
    const guard = pending.catch(e => e);
    await vi.advanceTimersByTimeAsync(31_000);
    const err = await guard;
    expect(err).toBeInstanceOf(WhoopTransientError);
    expect(err.message).toContain('timeout');
    const row = getOAuthToken(config, 'whoop');
    expect(row.refresh_token).toBe('RT1');
    expect(row.lock_token).toBeNull();
  });

  it('lock loser waits for the winner and returns the fresh token (no second HTTP call)', async () => {
    const f = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 700));
      return { ok: true, status: 200, text: async () => successBody(4) };
    });
    vi.stubGlobal('fetch', f);
    const [a, b] = await Promise.all([
      refreshAccessToken(config),
      refreshAccessToken(config),
    ]);
    expect(a).toBe('AT4');
    expect(b).toBe('AT4');
    expect(f).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('lock loser times out with RefreshUnavailableError when the holder never finishes', async () => {
    vi.useFakeTimers();
    // Simulate a foreign holder: lock taken, never released.
    getDb(config).prepare("UPDATE oauth_tokens SET locked_at=?, lock_token='foreign' WHERE provider='whoop'").run(nowSec());
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const pending = refreshAccessToken(config).catch(e => e);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await pending).toBeInstanceOf(RefreshUnavailableError);
    expect(f).not.toHaveBeenCalled();
  });
});

// ─── Dead-state semantics ───────────────────────────────────────────────────

describe('getAccessToken with a dead token', () => {
  it('invalid_grant death: throws immediately even with a locally-valid access token', async () => {
    seed({ status: 'dead', dead_reason: 'invalid_grant', dead_at: nowSec(), last_dead_probe_at: nowSec(), expires_at: nowSec() + 3000 });
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(getAccessToken(config)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(f).not.toHaveBeenCalled();
  });

  it('invalid_request death: still serves a locally-valid access token', async () => {
    seed({ status: 'dead', dead_reason: 'invalid_request_x3', dead_at: nowSec(), last_dead_probe_at: nowSec(), expires_at: nowSec() + 3000 });
    expect(await getAccessToken(config)).toBe('AT1');
  });

  it('zero token-endpoint HTTP in the first 12h after death; one CAS-claimed probe after', async () => {
    vi.useFakeTimers();
    const deadAt = nowSec();
    seed({ status: 'dead', dead_reason: 'invalid_request_x3', dead_at: deadAt, last_dead_probe_at: deadAt, expires_at: deadAt - 10 });
    const f = mockFetchResponse(400, INVALID_REQUEST_BODY);
    vi.stubGlobal('fetch', f);

    await expect(getAccessToken(config)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(f).not.toHaveBeenCalled(); // anchored at dead_at + 12h

    vi.setSystemTime(Date.now() + 12 * 3600_000 + 60_000);
    const p1 = getAccessToken(config).catch(e => e);
    await vi.runAllTimersAsync();
    expect(await p1).toBeInstanceOf(WhoopTransientError); // the probe itself ran
    expect(f).toHaveBeenCalledTimes(1);

    // A fresh caller (≈ restarted process — state is row-resident) cannot re-probe.
    const p2 = getAccessToken(config).catch(e => e);
    await vi.runAllTimersAsync();
    expect(await p2).toBeInstanceOf(ReauthRequiredError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('SSH-style row revival is observed without a restart (row truth, no caching)', async () => {
    seed({ status: 'dead', dead_reason: 'invalid_grant', dead_at: nowSec(), last_dead_probe_at: nowSec(), expires_at: nowSec() - 10 });
    await expect(getAccessToken(config)).rejects.toBeInstanceOf(ReauthRequiredError);
    // whoop-reauth.mjs writes the row directly:
    getDb(config).prepare(`
      UPDATE oauth_tokens SET access_token='ATre', refresh_token='RTre', expires_at=?,
        status='active', dead_reason=NULL, dead_at=NULL, consecutive_invalid_request=0,
        first_transient_failure_at=NULL, last_dead_probe_at=NULL
      WHERE provider='whoop'
    `).run(nowSec() + 3600);
    expect(await getAccessToken(config)).toBe('ATre');
  });

  it('escape-hatch probe success auto-revives the token', async () => {
    const deadAt = nowSec() - 13 * 3600; // probe eligible
    seed({ status: 'dead', dead_reason: 'invalid_request_x3', dead_at: deadAt, last_dead_probe_at: deadAt, expires_at: deadAt });
    vi.stubGlobal('fetch', mockFetchResponse(200, successBody(7)));
    expect(await getAccessToken(config)).toBe('AT7');
    const row = getOAuthToken(config, 'whoop');
    expect(row.status).toBe('active');
    expect(row.dead_reason).toBeNull();
  });

  it('no row at all → ReauthRequiredError naming the re-auth command', async () => {
    getDb(config).prepare('DELETE FROM oauth_tokens').run();
    const err = await getAccessToken(config).catch(e => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect(err.message).toContain('whoop-reauth');
  });
});

describe('data API while dead', () => {
  it('a 401 from the data API with a dead row surfaces as ReauthRequiredError', async () => {
    seed({ status: 'dead', dead_reason: 'invalid_request_x3', dead_at: nowSec(), last_dead_probe_at: nowSec(), expires_at: nowSec() + 3000 });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, text: async () => 'Authorization was not valid', json: async () => ({}),
    })));
    await expect(getRecovery(config, '2026-06-11', '2026-06-11')).rejects.toBeInstanceOf(ReauthRequiredError);
  });
});
