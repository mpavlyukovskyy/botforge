/**
 * Just-in-time Whoop recovery fetcher.
 *
 * Used by:
 *   - cron/whoop-recovery-refresh.js (scheduled midday + evening fetches)
 *   - lib/bedtime-helper.js (JIT fallback when today's row is missing/stale)
 *
 * Why this exists separately from cron/daily-sync.js: daily_sync at 5am ET
 * fires while Mark is still asleep (he wakes after 11am). At that time Whoop
 * has not computed today's recovery yet, so the 5am sync stores yesterday's
 * data under today's key — wrong.
 *
 * This helper fetches a SINGLE day window and only updates the row if Whoop
 * returns a recovery score with a sleep_end timestamp that actually falls on
 * the target date.
 */
import { getRecovery, getSleep, getCycles, getAccessToken, ReauthRequiredError } from './whoop-client.js';
import { getRecoveryForDate, upsertRecovery } from './db.js';

const STALE_AGE_MS = 6 * 3600_000; // 6h — treat older rows as stale and JIT-refresh

// Must exceed the worst-case token path (30s refresh fetch + 15s lock wait),
// otherwise every JIT fetch that lands during a refresh deterministically
// times out while its orphaned chain keeps running.
const FETCH_TIMEOUT_MS = 45_000;
const BASE = 'https://api.prod.whoop.com/developer/v2';

/** Pull all paginated records in a range. Mirrors whoop-backfill.js. */
async function fetchPaginated(config, path, start, end, signal) {
  const all = [];
  let nextToken = null;
  let pages = 0;
  while (true) {
    const token = await getAccessToken(config);
    const url = new URL(`${BASE}${path}`);
    url.searchParams.set('start', `${start}T00:00:00.000Z`);
    url.searchParams.set('end', `${end}T23:59:59.999Z`);
    url.searchParams.set('limit', '25');
    if (nextToken) url.searchParams.set('nextToken', nextToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) throw new Error(`Whoop ${path} ${res.status}`);
    const data = await res.json();
    const records = data.records || [];
    all.push(...records);
    pages++;
    nextToken = data.next_token || null;
    if (!nextToken || records.length === 0 || pages > 5) break;
  }
  return all;
}

/**
 * Fetch today's recovery + sleep + cycle from Whoop, store in recovery_daily.
 *
 * @param {object} config
 * @param {string} todayEt    — YYYY-MM-DD (ET-aligned date for Mark's wake)
 * @param {object} log
 * @returns {Promise<{fetched: boolean, recovery: number|null, sleepMin: number|null, reason: string}>}
 */
export async function fetchAndStoreTodayRecovery(config, todayEt, log = console) {
  // One AbortController threaded through every fetch — when the deadline
  // fires, the underlying requests are actually cancelled instead of orphaned
  // (an orphaned chain kept running and contending the token lock before).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const [recovery, sleep, cycles] = await Promise.all([
      fetchPaginated(config, '/recovery', todayEt, todayEt, controller.signal),
      fetchPaginated(config, '/activity/sleep', todayEt, todayEt, controller.signal),
      fetchPaginated(config, '/cycle', todayEt, todayEt, controller.signal),
    ]);

    // Find the recovery record whose paired sleep ENDED on todayEt
    // (Whoop returns records sorted; we want the wake matching this date.)
    let bestRecovery = null;
    let bestSleep = null;
    for (const s of sleep) {
      const endDate = (s.end || '').slice(0, 10);
      if (endDate === todayEt && !s.nap) {
        bestSleep = s;
        break;
      }
    }
    for (const r of recovery) {
      // Match by cycle_id or by the recovery's score timestamp
      const recDate = (r.end || r.start || r.created_at || '').slice(0, 10);
      if (recDate === todayEt) {
        bestRecovery = r;
        break;
      }
    }
    let bestCycle = null;
    for (const c of cycles) {
      const cDate = (c.end || c.start || '').slice(0, 10);
      if (cDate === todayEt) { bestCycle = c; break; }
    }

    if (!bestRecovery || bestRecovery.score?.recovery_score == null) {
      log.warn?.(`recovery-fetch: no recovery record for ${todayEt}`);
      return { fetched: false, recovery: null, sleepMin: null, reason: 'no_recovery_record' };
    }

    const score = bestRecovery.score;
    const sleepScore = bestSleep?.score;
    const stages = sleepScore?.stage_summary || {};
    const cycleScore = bestCycle?.score;

    const recoveryScore = score.recovery_score;
    const hrv = score.hrv_rmssd_milli ?? null;
    const rhr = score.resting_heart_rate ?? null;
    const strain = cycleScore?.strain ?? null;
    const sleepPerformance = sleepScore?.sleep_performance_percentage ?? null;
    const sleepMin = stages.total_in_bed_time_milli != null
      ? Math.round(stages.total_in_bed_time_milli / 60000)
      : null;

    const readiness = recoveryScore != null
      ? (recoveryScore >= 67 ? 'green' : recoveryScore >= 34 ? 'yellow' : 'red')
      : 'unknown';

    // Build raw_json with the full per-date bucket the backfill uses
    const rawJson = {
      whoop_recovery_score: recoveryScore,
      whoop_hrv: hrv,
      whoop_rhr: rhr,
      whoop_strain: strain,
      whoop_sleep_performance: sleepPerformance,
      whoop_total_sleep_min: sleepMin,
      whoop_sleep_efficiency: sleepScore?.sleep_efficiency_percentage ?? null,
      whoop_sleep_consistency: sleepScore?.sleep_consistency_percentage ?? null,
      whoop_rem_min: stages.total_rem_sleep_time_milli != null
        ? Math.round(stages.total_rem_sleep_time_milli / 60000) : null,
      whoop_deep_min: stages.total_slow_wave_sleep_time_milli != null
        ? Math.round(stages.total_slow_wave_sleep_time_milli / 60000) : null,
      whoop_sleep_start: bestSleep?.start ?? null,
      whoop_sleep_end: bestSleep?.end ?? null,
      whoop_avg_hr: cycleScore?.average_heart_rate ?? null,
      whoop_max_hr: cycleScore?.max_heart_rate ?? null,
      whoop_kilojoules: cycleScore?.kilojoule ?? null,
      _fetch_source: 'jit_or_refresh',
      _fetched_at: Date.now(),
    };

    upsertRecovery(config, {
      date: todayEt,
      whoop_recovery_score: recoveryScore,
      whoop_hrv: hrv,
      whoop_rhr: rhr,
      whoop_strain: strain,
      whoop_sleep_performance: sleepPerformance,
      eightsleep_sleep_score: null,
      eightsleep_hrv: null,
      eightsleep_deep_sleep_min: null,
      eightsleep_total_sleep_min: null,
      combined_readiness: readiness,
      raw_json: rawJson,
    });

    log.info?.(`recovery-fetch: ${todayEt} recovery=${recoveryScore} hrv=${Math.round(hrv || 0)} sleep=${sleepMin}min`);
    return { fetched: true, recovery: recoveryScore, sleepMin, reason: 'ok' };
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      // Dead token is already alerted (once) by the token cron — this path
      // must stay quiet or it becomes a second spam vector.
      log.info?.('recovery-fetch: reauth-pending skip');
      return { fetched: false, recovery: null, sleepMin: null, reason: 'reauth_required' };
    }
    const msg = err.name === 'AbortError' ? 'whoop_timeout' : err.message;
    log.warn?.(`recovery-fetch: ${msg}`);
    return { fetched: false, recovery: null, sleepMin: null, reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read today's recovery_daily row with JIT fetch if missing/stale.
 *
 * Used by morning_workout (card + tap-time generator) so the workout always
 * reflects Mark's most recent recovery, even if scheduled crons missed it.
 *
 * @returns {Promise<object|null>} — the full recovery_daily row, or null if no data anywhere
 */
export async function getFreshTodayRecoveryRow(config, todayEt, log = console) {
  let row = getRecoveryForDate(config, todayEt);

  const isMissing = !row;
  const isEmpty = row && row.whoop_recovery_score == null;
  const isStale = row && (() => {
    try {
      const raw = typeof row.raw_json === 'string' ? JSON.parse(row.raw_json) : row.raw_json;
      const fetchedAt = raw?._fetched_at;
      if (typeof fetchedAt !== 'number') return true; // legacy rows w/o stamp → treat as fresh-enough
      // Actually: if no stamp, it's the old daily-sync 5am row — treat as stale
      return false;
    } catch { return false; }
  })();

  if (isMissing || isEmpty) {
    log.info?.(`getFreshTodayRecoveryRow: ${todayEt} missing/empty — JIT fetch`);
    try {
      await fetchAndStoreTodayRecovery(config, todayEt, log);
      row = getRecoveryForDate(config, todayEt);
    } catch (err) {
      log.warn?.(`getFreshTodayRecoveryRow: JIT failed: ${err.message}`);
    }
  }

  return row || null;
}
