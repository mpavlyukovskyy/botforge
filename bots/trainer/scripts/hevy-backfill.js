/**
 * Hevy historical backfill — pulls all workouts to date, stores start_time.
 *
 * Adds `start_time` and `end_time` columns to workout_cache via ALTER TABLE
 * if missing, then syncs every workout Hevy has to date.
 *
 *   cd /opt/botforge
 *   set -a && source .env && set +a
 *   node bots/trainer/scripts/hevy-backfill.js
 */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(`${__dirname}/../../..`);

const log = {
  info: (m) => console.log('[INFO]', m),
  warn: (m) => console.warn('[WARN]', m),
  error: (m) => console.error('[ERR]', m),
};

const config = { name: 'Trainer' };
const { ensureDb } = await import('../lib/db.js');
const { getWorkouts, parseWorkoutForCache } = await import('../lib/hevy-client.js');

const db = ensureDb(config);

// Add start_time + end_time columns if missing
try { db.exec('ALTER TABLE workout_cache ADD COLUMN start_time TEXT'); log.info('Added start_time column'); }
catch { log.info('start_time column already exists'); }
try { db.exec('ALTER TABLE workout_cache ADD COLUMN end_time TEXT'); log.info('Added end_time column'); }
catch { log.info('end_time column already exists'); }

// Walk every page of Hevy workouts until we run out
const all = [];
let page = 1;
while (true) {
  const data = await getWorkouts(page, 10);
  const wks = data?.workouts || [];
  if (wks.length === 0) break;
  all.push(...wks);
  log.info(`page ${page}: ${wks.length} workouts (oldest: ${wks[wks.length - 1]?.start_time?.slice(0, 10) || '?'})`);
  if (data.page >= data.page_count) break;
  page++;
  await new Promise((r) => setTimeout(r, 200));
}

log.info(`Total workouts pulled: ${all.length}`);

const stmt = db.prepare(`
  INSERT OR REPLACE INTO workout_cache
    (id, date, title, exercises_json, duration_seconds, fetched_at, start_time, end_time)
  VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
`);

let upserts = 0;
for (const w of all) {
  const cached = parseWorkoutForCache(w);
  stmt.run(
    cached.id,
    cached.date,
    cached.title || null,
    cached.exercises_json ? JSON.stringify(cached.exercises_json) : null,
    cached.duration_seconds || null,
    w.start_time || null,
    w.end_time || null,
  );
  upserts++;
}

log.info(`Upserted ${upserts} workouts.`);

// Range
const range = db.prepare(`SELECT MIN(date), MAX(date), COUNT(*) FROM workout_cache`).get();
log.info(`workout_cache range: ${Object.values(range).join(' | ')}`);

console.log('HEVY BACKFILL DONE');
