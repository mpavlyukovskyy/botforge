/**
 * Whoop API client
 *
 * OAuth 2.0 with single-use rotating refresh tokens (ORY Hydra): every refresh
 * invalidates the old refresh token, and presenting a rotated token twice
 * revokes the WHOLE grant chain. The refresh path here is therefore built
 * around three rules (docs/RCA-whoop-token-spam-2026-06-11.md):
 *   1. Single writer: ownership-checked SQLite lock; the refresh token is
 *      re-read INSIDE the lock and never captured before it.
 *   2. Persist-before-return with CAS: a successful rotation is always
 *      persisted (discarding one would orphan the new token = self-kill);
 *      a stale success can never overwrite a newer token.
 *   3. Total error taxonomy with a transient default: only parsed-JSON
 *      invalid_grant (immediate) or invalid_request (3 consecutive) can mark
 *      the token dead, both CAS-guarded. Dead = no token-endpoint calls except
 *      one CAS-claimed verification probe per 12h. Recovery needs re-auth:
 *      node scripts/whoop-reauth.mjs
 */

import {
  getOAuthToken, lockOAuthToken, unlockOAuthToken,
  casUpdateTokenOnSuccess, casMarkTokenDead, casIncrementInvalidRequest,
  setFirstTransientFailure, casClaimDeadProbe, nowSec,
} from './db.js';

const BASE_URL = 'https://api.prod.whoop.com/developer/v2';
const PROD_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

const REFRESH_TIMEOUT_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 500;
const DEAD_PROBE_INTERVAL_SEC = 43_200; // 12h
const INVALID_REQUEST_DEATH_COUNT = 3;
const EXPIRY_MARGIN_SEC = 300;

export const REAUTH_CMD = 'cd ~/Documents/dev/botforge/bots/trainer && node scripts/whoop-reauth.mjs';

// Whoop's documented refresh body uses scope. The full proven list is kept
// deliberately — RFC 6749 §6 treats scope on refresh as a narrowing request,
// so sending less risks a silently down-scoped access token.
const SCOPES = 'offline read:recovery read:sleep read:cycles read:profile read:workout';

function tokenUrl() {
  return process.env.WHOOP_TOKEN_URL || PROD_TOKEN_URL;
}

function getClientId() {
  return process.env.WHOOP_CLIENT_ID;
}

function getClientSecret() {
  return process.env.WHOOP_CLIENT_SECRET;
}

// ─── Error classes ──────────────────────────────────────────────────────────

/** Token chain is dead or was never authorized — only a browser re-auth fixes it. */
export class ReauthRequiredError extends Error {
  constructor(message) { super(message); this.name = 'ReauthRequiredError'; }
}

/** Another caller is refreshing and hasn't finished — retry later. */
export class RefreshUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'RefreshUnavailableError'; }
}

/** Client credentials problem — re-auth would NOT fix this. */
export class WhoopConfigError extends Error {
  constructor(message) { super(message); this.name = 'WhoopConfigError'; }
}

/** Retryable failure (network, 5xx, 429, unparseable, not-yet-dead 400s). */
export class WhoopTransientError extends Error {
  constructor(message, invalidRequestCount = null) {
    super(message);
    this.name = 'WhoopTransientError';
    this.invalidRequestCount = invalidRequestCount;
  }
}

// ─── Failure classification ────────────────────────────────────────────────

/**
 * Total classification of a non-2xx token-endpoint response.
 * Returns { class: 'config'|'invalid_grant'|'invalid_request'|'transient', detail }.
 * Anything unparseable or unrecognized is TRANSIENT — a Cloudflare HTML page
 * or unknown status must never count toward token death.
 */
export function classifyRefreshFailure(status, bodyText) {
  let body = null;
  try { body = JSON.parse(bodyText); } catch { /* non-JSON → transient below */ }
  const err = body?.error;
  const desc = `${body?.error_description || ''} ${body?.error_hint || ''}`.trim();

  if (status === 401 || err === 'invalid_client' || err === 'unauthorized_client') {
    return { class: 'config', detail: `${status} ${err || String(bodyText).slice(0, 120)}` };
  }
  if (err === 'invalid_grant') {
    return { class: 'invalid_grant', detail: desc || 'invalid_grant' };
  }
  if (err === 'invalid_request') {
    // fosite's concurrent-refresh storage conflicts surface as invalid_request
    // with these descriptions — they are retryable, not a dead token.
    if (/multiple concurrent|please retry/i.test(desc)) {
      return { class: 'transient', detail: 'concurrent-refresh conflict' };
    }
    return { class: 'invalid_request', detail: desc || 'invalid_request' };
  }
  return { class: 'transient', detail: `HTTP ${status}` };
}

// ─── Token management ───────────────────────────────────────────────────────

/**
 * Get a valid access token, refreshing if needed.
 * Dead-token semantics:
 *  - invalid_grant death: the chain (incl. the access token) is revoked
 *    server-side → throw immediately.
 *  - invalid_request-class death: a locally-valid access token is still served
 *    until expiry; afterwards only the 12h escape-hatch probe may refresh.
 */
export async function getAccessToken(config) {
  const row = getOAuthToken(config, 'whoop');
  if (!row) {
    throw new ReauthRequiredError(`No Whoop OAuth token. Authorize with: ${REAUTH_CMD}`);
  }
  const now = nowSec();

  if (row.status === 'dead') {
    if (row.dead_reason !== 'invalid_grant' && (row.expires_at || 0) > now + EXPIRY_MARGIN_SEC) {
      return row.access_token;
    }
    if (row.refresh_token && casClaimDeadProbe(config, 'whoop', row.refresh_token, DEAD_PROBE_INTERVAL_SEC)) {
      return refreshAccessToken(config);
    }
    throw new ReauthRequiredError(
      `Whoop token dead since ${row.dead_at ? new Date(row.dead_at * 1000).toISOString() : '?'} (${row.dead_reason}). Re-auth: ${REAUTH_CMD}`
    );
  }

  if ((row.expires_at || 0) > now + EXPIRY_MARGIN_SEC) {
    return row.access_token;
  }

  if (!row.refresh_token) {
    throw new ReauthRequiredError(`Whoop token expired and no refresh token available. Re-auth: ${REAUTH_CMD}`);
  }

  return refreshAccessToken(config);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Refresh the access token. Single-writer via ownership lock; refresh token
 * re-read inside the lock; success persisted via CAS before returning.
 *
 * Throws: WhoopConfigError | ReauthRequiredError | RefreshUnavailableError |
 *         WhoopTransientError.
 */
export async function refreshAccessToken(config) {
  if (!getClientId() || !getClientSecret()) {
    throw new WhoopConfigError('WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET missing or empty — check /opt/botforge/.env on acemagic');
  }

  const lockToken = lockOAuthToken(config, 'whoop');
  if (!lockToken) {
    // Lock loser: wait for the holder to finish, then use their result.
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_MS);
      const row = getOAuthToken(config, 'whoop');
      if (!row) break;
      if (row.lock_token == null) {
        if (row.status !== 'dead' && (row.expires_at || 0) > nowSec() + EXPIRY_MARGIN_SEC) {
          return row.access_token;
        }
        break; // holder finished but did not produce a fresh token
      }
    }
    throw new RefreshUnavailableError('Whoop refresh in progress by another caller and no fresh token available yet');
  }

  try {
    // Re-read INSIDE the lock — the only refresh token we may present.
    const row = getOAuthToken(config, 'whoop');
    if (!row || !row.refresh_token) {
      throw new ReauthRequiredError(`No Whoop refresh token available. Re-auth: ${REAUTH_CMD}`);
    }
    if (row.status !== 'dead' && (row.expires_at || 0) > nowSec() + EXPIRY_MARGIN_SEC) {
      return row.access_token; // someone refreshed between our trigger and the lock
    }
    const used = row.refresh_token;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let res, bodyText;
    try {
      // The abort signal covers the FULL exchange including the body read — a
      // trickling response can otherwise hold the lock past the steal window.
      res = await fetch(tokenUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: used,
          client_id: getClientId(),
          client_secret: getClientSecret(),
          scope: SCOPES,
        }),
        signal: controller.signal,
      });
      bodyText = await res.text();
    } catch (err) {
      setFirstTransientFailure(config, 'whoop');
      throw new WhoopTransientError(`Whoop token refresh: ${err.name === 'AbortError' ? 'timeout after 30s' : err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return handleRefreshFailure(config, used, res.status, bodyText);
    }

    let data = null;
    try { data = JSON.parse(bodyText); } catch { /* handled below */ }
    if (!data || !data.access_token) {
      setFirstTransientFailure(config, 'whoop');
      throw new WhoopTransientError(`Whoop token refresh: 2xx with unusable body (${String(bodyText).slice(0, 120)})`);
    }

    const expiresAt = nowSec() + (data.expires_in || 3600);
    const persisted = casUpdateTokenOnSuccess(config, 'whoop', used, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || used,
      expiresAt,
    });
    if (!persisted) {
      // Token rotated under us (e.g. re-auth installed a new chain mid-flight).
      // Our result belongs to the old chain — discard it, use the newer row.
      const fresh = getOAuthToken(config, 'whoop');
      if (fresh && fresh.status !== 'dead' && (fresh.expires_at || 0) > nowSec()) {
        return fresh.access_token;
      }
      throw new WhoopTransientError('Whoop token refresh: token rotated concurrently; discarded stale result');
    }
    return data.access_token;
  } finally {
    unlockOAuthToken(config, 'whoop', lockToken);
  }
}

function handleRefreshFailure(config, used, status, bodyText) {
  const cls = classifyRefreshFailure(status, bodyText);

  if (cls.class === 'config') {
    throw new WhoopConfigError(`Whoop client auth failed (${cls.detail}) — check WHOOP_CLIENT_ID/SECRET on acemagic; re-auth would NOT fix this`);
  }

  if (cls.class === 'invalid_grant') {
    if (casMarkTokenDead(config, 'whoop', used, 'invalid_grant')) {
      throw new ReauthRequiredError(`Whoop refresh token rejected (invalid_grant) — chain revoked. Re-auth: ${REAUTH_CMD}`);
    }
    // Rotated under us — the failure was for a stale token; a newer one exists.
    const fresh = getOAuthToken(config, 'whoop');
    if (fresh && fresh.status !== 'dead' && (fresh.expires_at || 0) > nowSec()) {
      return fresh.access_token;
    }
    throw new WhoopTransientError('Whoop token refresh: stale invalid_grant after concurrent rotation');
  }

  if (cls.class === 'invalid_request') {
    const n = casIncrementInvalidRequest(config, 'whoop', used);
    if (n != null && n >= INVALID_REQUEST_DEATH_COUNT) {
      if (casMarkTokenDead(config, 'whoop', used, 'invalid_request_x3')) {
        throw new ReauthRequiredError(`Whoop refresh failing permanently (invalid_request ×${n}) — token presumed dead. Re-auth: ${REAUTH_CMD}`);
      }
    }
    throw new WhoopTransientError(`Whoop token refresh: 400 invalid_request (${n ?? 'stale'}/${INVALID_REQUEST_DEATH_COUNT}): ${cls.detail}`, n);
  }

  setFirstTransientFailure(config, 'whoop');
  throw new WhoopTransientError(`Whoop token refresh: ${cls.detail} ${String(bodyText).slice(0, 120)}`);
}

// ─── API calls ──────────────────────────────────────────────────────────────

async function apiGet(config, path, params = {}) {
  const accessToken = await getAccessToken(config);
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    if (res.status === 401) {
      const row = getOAuthToken(config, 'whoop');
      if (row?.status === 'dead') {
        // Chain revoked server-side while the local expiry still looked valid.
        throw new ReauthRequiredError(`Whoop API 401 with dead token. Re-auth: ${REAUTH_CMD}`);
      }
    }
    const body = await res.text().catch(() => '');
    throw new Error(`Whoop API ${path} failed: ${res.status} ${body}`);
  }

  return res.json();
}

/**
 * Get recovery data for a date range.
 * @param {string} start - ISO date string
 * @param {string} end - ISO date string
 */
export async function getRecovery(config, start, end) {
  return apiGet(config, '/recovery', {
    start: `${start}T00:00:00.000Z`,
    end: `${end}T23:59:59.999Z`,
  });
}

/**
 * Get sleep data for a date range.
 */
export async function getSleep(config, start, end) {
  return apiGet(config, '/activity/sleep', {
    start: `${start}T00:00:00.000Z`,
    end: `${end}T23:59:59.999Z`,
  });
}

/**
 * Get cycle (strain) data for a date range.
 */
export async function getCycles(config, start, end) {
  return apiGet(config, '/cycle', {
    start: `${start}T00:00:00.000Z`,
    end: `${end}T23:59:59.999Z`,
  });
}

/**
 * Get user profile.
 */
export async function getProfile(config) {
  return apiGet(config, '/user/profile/basic');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse Whoop recovery response into our flat format.
 */
export function parseRecoveryData(recoveryData) {
  if (!recoveryData || !recoveryData.records || recoveryData.records.length === 0) {
    return null;
  }

  // Most recent record (API returns newest-first)
  const record = recoveryData.records[0];
  const score = record.score;

  return {
    recovery_score: score?.recovery_score ?? null,
    hrv: score?.hrv_rmssd_milli ?? null,
    rhr: score?.resting_heart_rate ?? null,
    spo2: score?.spo2_percentage ?? null,
    skin_temp: score?.skin_temp_celsius ?? null,
  };
}

/**
 * Parse Whoop sleep data.
 */
export function parseSleepData(sleepData) {
  if (!sleepData || !sleepData.records || sleepData.records.length === 0) {
    return null;
  }

  const record = sleepData.records[0];
  const score = record.score;

  return {
    sleep_performance: score?.sleep_performance_percentage ?? null,
    sleep_efficiency: score?.sleep_efficiency_percentage ?? null,
    total_sleep_min: score?.total_in_bed_time_milli
      ? Math.round(score.total_in_bed_time_milli / 60000)
      : null,
    rem_min: score?.total_rem_sleep_time_milli
      ? Math.round(score.total_rem_sleep_time_milli / 60000)
      : null,
    deep_min: score?.total_slow_wave_sleep_time_milli
      ? Math.round(score.total_slow_wave_sleep_time_milli / 60000)
      : null,
  };
}

/**
 * Parse Whoop cycle/strain data.
 */
export function parseCycleData(cycleData) {
  if (!cycleData || !cycleData.records || cycleData.records.length === 0) {
    return null;
  }

  const record = cycleData.records[0];
  const score = record.score;

  return {
    strain: score?.strain ?? null,
    average_hr: score?.average_heart_rate ?? null,
    max_hr: score?.max_heart_rate ?? null,
    kilojoules: score?.kilojoule ?? null,
  };
}
