/**
 * Eight Sleep API client (unofficial)
 *
 * Direct email/password auth against client-api.8slp.net.
 * Graceful degradation: returns null on any failure.
 */

const BASE_URL = 'https://client-api.8slp.net/v1';

let _accessToken = null;
let _tokenExpiresAt = 0;
let _userId = null;

// ─── Auth ───────────────────────────────────────────────────────────────────

async function authenticate() {
  const email = process.env.EIGHT_SLEEP_EMAIL;
  const password = process.env.EIGHT_SLEEP_PASSWORD;
  const clientId = process.env.EIGHT_SLEEP_CLIENT_ID;
  const clientSecret = process.env.EIGHT_SLEEP_CLIENT_SECRET;

  if (!email || !password) return null;

  try {
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        ...(clientId && { client_id: clientId }),
        ...(clientSecret && { client_secret: clientSecret }),
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    _accessToken = data.session?.token || null;
    _userId = data.session?.userId || null;
    _tokenExpiresAt = Date.now() + (3600 * 1000); // assume 1 hour
    return _accessToken;
  } catch {
    return null;
  }
}

async function getToken() {
  if (_accessToken && Date.now() < _tokenExpiresAt - 60000) {
    return _accessToken;
  }
  return authenticate();
}

// ─── API ────────────────────────────────────────────────────────────────────

async function apiGet(path) {
  const token = await getToken();
  if (!token) return null;

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ─── Data fetching ──────────────────────────────────────────────────────────

/**
 * Get sleep data for a specific date.
 * Returns null if Eight Sleep is unavailable.
 */
export async function getSleepData(date) {
  if (!process.env.EIGHT_SLEEP_EMAIL) return null;

  try {
    // Get user info to find their side
    if (!_userId) {
      const token = await getToken();
      if (!token) return null;
    }

    const data = await apiGet(`/users/${_userId}/trends`);
    if (!data) return null;

    // Find the day's data
    const days = data.days || [];
    const day = days.find(d => d.day === date);
    if (!day) return null;

    return parseSleepData(day);
  } catch {
    return null;
  }
}

/**
 * Get recent sleep data (last N days).
 */
export async function getRecentSleep(days = 7) {
  if (!process.env.EIGHT_SLEEP_EMAIL) return null;

  try {
    if (!_userId) {
      const token = await getToken();
      if (!token) return null;
    }

    const data = await apiGet(`/users/${_userId}/trends?num_days=${days}`);
    if (!data) return null;

    return (data.days || []).map(parseSleepData).filter(Boolean);
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseSleepData(day) {
  if (!day) return null;

  const sleep = day.sleepFitnessScore || day.score;

  return {
    date: day.day || null,
    sleep_score: sleep?.total ?? day.score ?? null,
    hrv: day.averageHrv ?? null,
    rhr: day.averageHeartRate ?? null,
    deep_sleep_min: day.deepSleepDuration
      ? Math.round(day.deepSleepDuration / 60)
      : null,
    total_sleep_min: day.totalSleepDuration
      ? Math.round(day.totalSleepDuration / 60)
      : null,
    rem_sleep_min: day.remSleepDuration
      ? Math.round(day.remSleepDuration / 60)
      : null,
    tosses_turns: day.tossAndTurns ?? null,
    bed_temp: day.weatherTemp ?? null,
  };
}

/**
 * Check if Eight Sleep integration is configured.
 */
export function isConfigured() {
  return !!(process.env.EIGHT_SLEEP_EMAIL && process.env.EIGHT_SLEEP_PASSWORD);
}
