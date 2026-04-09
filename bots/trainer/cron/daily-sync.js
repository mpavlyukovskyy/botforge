/**
 * Cron handler: daily_sync
 *
 * 5am ET — Fetch Whoop recovery, Eight Sleep sleep, Hevy workouts.
 * Caches everything in SQLite. Computes combined readiness.
 */
import {
  ensureDb, upsertRecovery, upsertWorkoutCache,
  upsertExerciseTemplate, getExerciseTemplate,
} from '../lib/db.js';
import { getRecovery, getSleep, getCycles, parseRecoveryData, parseSleepData, parseCycleData } from '../lib/whoop-client.js';
import { getSleepData, isConfigured as eightsleepConfigured } from '../lib/eightsleep-client.js';
import { getWorkoutsInRange, syncTemplatesFromWorkouts, parseWorkoutForCache, fetchAllExerciseTemplates } from '../lib/hevy-client.js';

export default {
  name: 'daily_sync',
  async execute(ctx) {
    try {
      ensureDb(ctx.config);
    } catch (err) {
      ctx.log.error(`Daily sync: DB not available: ${err.message}`);
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    ctx.log.info('Daily sync starting...');

    let whoopData = null;
    let eightsleepData = null;

    // ── Whoop ───────────────────────────────────────────────────────────────
    try {
      const [recoveryResult, sleepResult, cycleResult] = await Promise.allSettled([
        getRecovery(ctx.config, yesterday, today),
        getSleep(ctx.config, yesterday, today),
        getCycles(ctx.config, yesterday, today),
      ]);

      const recoveryRes = recoveryResult.status === 'fulfilled' ? recoveryResult.value : null;
      const sleepRes = sleepResult.status === 'fulfilled' ? sleepResult.value : null;
      const cycleRes = cycleResult.status === 'fulfilled' ? cycleResult.value : null;

      if (recoveryResult.status === 'rejected') ctx.log.warn(`Whoop recovery: ${recoveryResult.reason?.message}`);
      if (sleepResult.status === 'rejected') ctx.log.warn(`Whoop sleep: ${sleepResult.reason?.message}`);
      if (cycleResult.status === 'rejected') ctx.log.warn(`Whoop cycle: ${cycleResult.reason?.message}`);

      const recovery = parseRecoveryData(recoveryRes);
      const sleep = parseSleepData(sleepRes);
      const cycle = parseCycleData(cycleRes);

      whoopData = {
        recovery_score: recovery?.recovery_score,
        hrv: recovery?.hrv,
        rhr: recovery?.rhr,
        strain: cycle?.strain,
        sleep_performance: sleep?.sleep_performance,
      };

      ctx.log.info(`Whoop synced: recovery ${whoopData.recovery_score ?? '-'}%, HRV ${Math.round(whoopData.hrv || 0)}ms`);
    } catch (err) {
      ctx.log.warn(`Whoop sync failed: ${err.message}`);
    }

    // ── Eight Sleep ──────��──────────────────────────────────────────────────
    if (eightsleepConfigured()) {
      try {
        eightsleepData = await getSleepData(today) || await getSleepData(yesterday);
        if (eightsleepData) {
          ctx.log.info(`Eight Sleep synced: score ${eightsleepData.sleep_score}`);
        }
      } catch (err) {
        ctx.log.warn(`Eight Sleep sync failed: ${err.message}`);
      }
    }

    // ── Compute combined readiness ──────────────────────────────────────────
    const readiness = computeReadiness(whoopData, eightsleepData);

    // ── Store recovery ──────────��───────────────────────────────────────────
    upsertRecovery(ctx.config, {
      date: today,
      whoop_recovery_score: whoopData?.recovery_score ?? null,
      whoop_hrv: whoopData?.hrv ?? null,
      whoop_rhr: whoopData?.rhr ?? null,
      whoop_strain: whoopData?.strain ?? null,
      whoop_sleep_performance: whoopData?.sleep_performance ?? null,
      eightsleep_sleep_score: eightsleepData?.sleep_score ?? null,
      eightsleep_hrv: eightsleepData?.hrv ?? null,
      eightsleep_deep_sleep_min: eightsleepData?.deep_sleep_min ?? null,
      eightsleep_total_sleep_min: eightsleepData?.total_sleep_min ?? null,
      combined_readiness: readiness,
      raw_json: { whoop: whoopData, eightsleep: eightsleepData },
    });

    // ── Hevy workouts (last 14 days) ─────���──────────────────────────────────
    try {
      const startDate = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const workouts = await getWorkoutsInRange(startDate, today);

      for (const w of workouts) {
        const cached = parseWorkoutForCache(w);
        upsertWorkoutCache(ctx.config, cached);
      }

      // Sync exercise templates from these workouts
      const { total, fetched } = await syncTemplatesFromWorkouts(
        workouts,
        (id) => getExerciseTemplate(ctx.config, id),
        (tmpl) => upsertExerciseTemplate(ctx.config, tmpl),
      );

      ctx.log.info(`Hevy synced: ${workouts.length} workouts, ${total} templates (${fetched} new)`);
    } catch (err) {
      ctx.log.warn(`Hevy sync failed: ${err.message}`);
    }

    // ── Full exercise template sync ──────────────────────────────────────────
    try {
      const allTemplates = await fetchAllExerciseTemplates();
      let newCount = 0;
      for (const t of allTemplates) {
        const existing = getExerciseTemplate(ctx.config, t.id);
        if (!existing) newCount++;
        upsertExerciseTemplate(ctx.config, {
          id: t.id,
          title: t.title,
          muscle_group: t.primary_muscle_group || null,
          equipment: t.equipment || null,
        });
      }
      ctx.log.info(`Template sync: ${allTemplates.length} total, ${newCount} new`);
    } catch (err) {
      ctx.log.warn(`Full template sync failed: ${err.message}`);
    }

    ctx.log.info(`Daily sync complete. Readiness: ${readiness}`);
  },
};

/**
 * Compute combined readiness from Whoop + Eight Sleep data.
 * Returns 'green', 'yellow', or 'red'.
 */
function computeReadiness(whoop, eightsleep) {
  const scores = [];

  // Whoop recovery score (0-100)
  if (whoop?.recovery_score != null) {
    scores.push(whoop.recovery_score);
  }

  // Eight Sleep sleep score (0-100 typically)
  if (eightsleep?.sleep_score != null) {
    scores.push(eightsleep.sleep_score);
  }

  if (scores.length === 0) return 'unknown';

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  if (avg >= 67) return 'green';
  if (avg >= 34) return 'yellow';
  return 'red';
}
