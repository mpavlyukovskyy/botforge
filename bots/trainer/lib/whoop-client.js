/**
 * Whoop API client
 *
 * OAuth 2.0. Tokens stored in SQLite oauth_tokens table.
 * Note: If 'offline' scope is unavailable, refresh tokens won't be issued.
 * In that case, re-run whoop-auth.js when tokens expire (~1 hour).
 * The token-refresh cron will alert via Telegram when re-auth is needed.
 */

import { getOAuthToken, upsertOAuthToken, lockOAuthToken, unlockOAuthToken } from './db.js';

const BASE_URL = 'https://api.prod.whoop.com/developer/v2';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

function getClientId() {
  return process.env.WHOOP_CLIENT_ID;
}

function getClientSecret() {
  return process.env.WHOOP_CLIENT_SECRET;
}

// ─── Token management ───────────────────────────────────────────────────────

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getAccessToken(config) {
  const token = getOAuthToken(config, 'whoop');
  if (!token) throw new Error('No Whoop OAuth token found. Run whoop-auth.js first.');

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = token.expires_at || 0;

  // If token expires in more than 5 minutes, use it
  if (expiresAt > now + 300) {
    return token.access_token;
  }

  // Need refresh
  if (!token.refresh_token) {
    throw new Error('Whoop token expired and no refresh token available. Re-run whoop-auth.js.');
  }

  return refreshAccessToken(config, token.refresh_token);
}

/**
 * Refresh the access token using the refresh token.
 * Uses SQLite mutex to prevent concurrent refreshes.
 */
export async function refreshAccessToken(config, refreshToken) {
  // Try to acquire lock
  const locked = lockOAuthToken(config, 'whoop');
  if (!locked) {
    // Another process is refreshing — wait and re-read
    await new Promise(r => setTimeout(r, 2000));
    const token = getOAuthToken(config, 'whoop');
    if (token) return token.access_token;
    throw new Error('Token refresh in progress by another process');
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: getClientId(),
        client_secret: getClientSecret(),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Whoop token refresh failed: ${res.status} ${body}`);
    }

    const data = await res.json();
    const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);

    upsertOAuthToken(
      config,
      'whoop',
      data.access_token,
      data.refresh_token || refreshToken,
      expiresAt
    );

    return data.access_token;
  } finally {
    unlockOAuthToken(config, 'whoop');
  }
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
