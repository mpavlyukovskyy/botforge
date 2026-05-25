/**
 * One-shot Whoop historical backfill.
 *
 * Fetches recovery, sleep, and cycle (strain) data for a date range, then
 * upserts into `recovery_daily` one row per date.
 *
 *   cd /opt/botforge
 *   set -a && source .env && set +a
 *   node bots/trainer/scripts/whoop-backfill.js [START_DATE] [END_DATE]
 *
 * Defaults: START=2026-01-01, END=today.
 *
 * Whoop API returns records for each cycle (a "cycle" is roughly a day, but
 * Whoop's day boundary is determined by sleep onset, not midnight). We match
 * each record to its calendar date using the record's `start` timestamp.
 */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(`${__dirname}/../../..`);

const argStart = process.argv[2];
const argEnd = process.argv[3];

const today = new Date().toISOString().slice(0, 10);
const START = argStart || '2026-01-01';
const END = argEnd || today;

const log = {
  info: (m) => console.log('[INFO]', m),
  warn: (m) => console.warn('[WARN]', m),
  error: (m) => console.error('[ERR]', m),
  debug: (m) => console.log('[DBG]', m),
};

console.log(`Whoop backfill: ${START} -> ${END}`);

const config = { name: 'Trainer' };
const { ensureDb, upsertRecovery, getOAuthToken } = await import('../lib/db.js');
const { getAccessToken } = await import('../lib/whoop-client.js');

const BASE = 'https://api.prod.whoop.com/developer/v2';

async function fetchAllPaginated(path, start, end) {
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
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Whoop ${path} ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const records = data.records || [];
    all.push(...records);
    pages++;
    nextToken = data.next_token || null;
    if (!nextToken || records.length === 0) break;
    if (pages > 50) {
      log.warn(`fetchAllPaginated(${path}): hit page limit 50`);
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

async function getRecovery(_cfg, start, end) {
  return { records: await fetchAllPaginated('/recovery', start, end) };
}
async function getSleep(_cfg, start, end) {
  return { records: await fetchAllPaginated('/activity/sleep', start, end) };
}
async function getCycles(_cfg, start, end) {
  return { records: await fetchAllPaginated('/cycle', start, end) };
}

ensureDb(config);

// Verify token
const token = getOAuthToken(config, 'whoop');
if (!token) {
  console.error('No Whoop token in DB. Run whoop-auth.js first.');
  process.exit(1);
}
log.info(`Token expires at ${new Date(token.expires_at * 1000).toISOString()}`);

// Chunk the range into 30-day windows to stay under any Whoop API limits.
function chunkDateRange(start, end, days) {
  const chunks = [];
  let s = new Date(start);
  const e = new Date(end);
  while (s <= e) {
    const chunkEnd = new Date(Math.min(s.getTime() + (days - 1) * 86400000, e.getTime()));
    chunks.push([
      s.toISOString().slice(0, 10),
      chunkEnd.toISOString().slice(0, 10),
    ]);
    s = new Date(chunkEnd.getTime() + 86400000);
  }
  return chunks;
}

function extractDate(record) {
  // Records have a `start` timestamp (e.g., "2026-05-23T05:30:00.000Z").
  // We assign to the LOCAL date the cycle ended on (using `end` if available, else `start`).
  // For sleep, `end` is wake time — the calendar date of the day this sleep "belongs to".
  const ts = record.end || record.start || record.created_at;
  if (!ts) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

// Aggregate per-date
const perDate = new Map();
function getDateBucket(d) {
  if (!perDate.has(d)) perDate.set(d, { date: d });
  return perDate.get(d);
}

let totalRecovery = 0;
let totalSleep = 0;
let totalCycle = 0;

const chunks = chunkDateRange(START, END, 25);
log.info(`Fetching ${chunks.length} chunks of ~25 days each`);

for (const [chunkStart, chunkEnd] of chunks) {
  log.info(`Chunk: ${chunkStart} -> ${chunkEnd}`);

  // Recovery
  try {
    const rec = await getRecovery(config, chunkStart, chunkEnd);
    const records = rec?.records || [];
    log.info(`  recovery: ${records.length} records`);
    for (const r of records) {
      const d = extractDate(r);
      if (!d) continue;
      const score = r.score || {};
      const bucket = getDateBucket(d);
      bucket.whoop_recovery_score = score.recovery_score ?? bucket.whoop_recovery_score;
      bucket.whoop_hrv = score.hrv_rmssd_milli ?? bucket.whoop_hrv;
      bucket.whoop_rhr = score.resting_heart_rate ?? bucket.whoop_rhr;
      bucket.whoop_spo2 = score.spo2_percentage ?? bucket.whoop_spo2;
      bucket.whoop_skin_temp = score.skin_temp_celsius ?? bucket.whoop_skin_temp;
      bucket.recovery_state = r.score_state || bucket.recovery_state;
      bucket.cycle_id = r.cycle_id || bucket.cycle_id;
      totalRecovery++;
    }
  } catch (e) {
    log.error(`Recovery fetch failed for ${chunkStart}->${chunkEnd}: ${e.message}`);
  }

  // Sleep
  try {
    const sleep = await getSleep(config, chunkStart, chunkEnd);
    const records = sleep?.records || [];
    log.info(`  sleep: ${records.length} records`);
    for (const r of records) {
      // For sleep, use end time as the date (wake-up day)
      const d = extractDate(r);
      if (!d) continue;
      const score = r.score || {};
      const stages = score.stage_summary || {};
      const bucket = getDateBucket(d);
      bucket.whoop_sleep_performance = score.sleep_performance_percentage ?? bucket.whoop_sleep_performance;
      bucket.whoop_sleep_efficiency = score.sleep_efficiency_percentage ?? bucket.whoop_sleep_efficiency;
      bucket.whoop_sleep_consistency = score.sleep_consistency_percentage ?? bucket.whoop_sleep_consistency;
      // Total time in bed (ms) -> minutes
      const inBedMs = stages.total_in_bed_time_milli;
      if (inBedMs != null) bucket.whoop_total_sleep_min = Math.round(inBedMs / 60000);
      const remMs = stages.total_rem_sleep_time_milli;
      if (remMs != null) bucket.whoop_rem_min = Math.round(remMs / 60000);
      const slowWaveMs = stages.total_slow_wave_sleep_time_milli;
      if (slowWaveMs != null) bucket.whoop_deep_min = Math.round(slowWaveMs / 60000);
      bucket.whoop_sleep_start = r.start;
      bucket.whoop_sleep_end = r.end;
      bucket.is_nap = r.nap;
      totalSleep++;
    }
  } catch (e) {
    log.error(`Sleep fetch failed for ${chunkStart}->${chunkEnd}: ${e.message}`);
  }

  // Cycles (strain)
  try {
    const cyc = await getCycles(config, chunkStart, chunkEnd);
    const records = cyc?.records || [];
    log.info(`  cycles: ${records.length} records`);
    for (const r of records) {
      const d = extractDate(r);
      if (!d) continue;
      const score = r.score || {};
      const bucket = getDateBucket(d);
      bucket.whoop_strain = score.strain ?? bucket.whoop_strain;
      bucket.whoop_avg_hr = score.average_heart_rate ?? bucket.whoop_avg_hr;
      bucket.whoop_max_hr = score.max_heart_rate ?? bucket.whoop_max_hr;
      bucket.whoop_kilojoules = score.kilojoule ?? bucket.whoop_kilojoules;
      bucket.cycle_start = r.start;
      bucket.cycle_end = r.end;
      totalCycle++;
    }
  } catch (e) {
    log.error(`Cycle fetch failed for ${chunkStart}->${chunkEnd}: ${e.message}`);
  }

  // Throttle a touch between chunks
  await new Promise((r) => setTimeout(r, 250));
}

log.info(`Totals: ${totalRecovery} recovery, ${totalSleep} sleep, ${totalCycle} cycle records`);

// Upsert per-date rows
const sortedDates = [...perDate.keys()].sort();
log.info(`Distinct dates: ${sortedDates.length} (${sortedDates[0] || '?'} -> ${sortedDates[sortedDates.length - 1] || '?'})`);

let upserts = 0;
for (const d of sortedDates) {
  const b = perDate.get(d);
  // Computed readiness based on whoop_recovery_score
  const score = b.whoop_recovery_score;
  let readiness = 'unknown';
  if (score != null) {
    readiness = score >= 67 ? 'green' : score >= 34 ? 'yellow' : 'red';
  }
  try {
    upsertRecovery(config, {
      date: d,
      whoop_recovery_score: b.whoop_recovery_score ?? null,
      whoop_hrv: b.whoop_hrv ?? null,
      whoop_rhr: b.whoop_rhr ?? null,
      whoop_strain: b.whoop_strain ?? null,
      whoop_sleep_performance: b.whoop_sleep_performance ?? null,
      eightsleep_sleep_score: null,
      eightsleep_hrv: null,
      eightsleep_deep_sleep_min: null,
      eightsleep_total_sleep_min: null,
      combined_readiness: readiness,
      raw_json: b, // Full per-date bucket — preserves all extracted fields including sleep_min, strain, hr, etc.
    });
    upserts++;
  } catch (e) {
    log.error(`Upsert failed for ${d}: ${e.message}`);
  }
}

log.info(`Upserted ${upserts} rows into recovery_daily.`);
console.log('BACKFILL DONE');
