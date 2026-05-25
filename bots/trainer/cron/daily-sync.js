/**
 * Cron handler: daily_sync
 *
 * 5am ET — Fetch Whoop recovery, Eight Sleep sleep, Hevy workouts.
 * Caches everything in SQLite. Computes combined readiness.
 */
import {
  ensureDb, upsertRecovery, upsertWorkoutCache,
  upsertExerciseTemplate, getExerciseTemplate,
  getExerciseConfig, upsertExerciseConfig, getAllExerciseTemplates,
  getActiveProgram, getCachedWorkouts,
  getExerciseProgression, upsertExerciseProgression,
  getAllExerciseConfigs, updateMuscleFatigue,
  getFeedbackForDate,
} from '../lib/db.js';
// Feedback prompts removed 2026-05-23 — Mark explicitly doesn't want post-workout questions.
import { getRecovery, getSleep, getCycles, parseRecoveryData, parseSleepData, parseCycleData } from '../lib/whoop-client.js';
import { getSleepData, isConfigured as eightsleepConfigured } from '../lib/eightsleep-client.js';
import { getWorkoutsInRange, syncTemplatesFromWorkouts, parseWorkoutForCache, fetchAllExerciseTemplates } from '../lib/hevy-client.js';
import { classifyExercise } from '../lib/exercise-classifier.js';
import { computeMuscleFatigue } from '../lib/muscle-fatigue.js';

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

    // ── Auto-populate exercise_config from templates ─────────────────────
    try {
      const allTemplates = getAllExerciseTemplates(ctx.config);
      let configCount = 0;
      for (const tmpl of allTemplates) {
        const existing = getExerciseConfig(ctx.config, tmpl.title);
        if (!existing) {
          const classified = classifyExercise(tmpl.title, tmpl.equipment, tmpl.muscle_group);
          upsertExerciseConfig(ctx.config, {
            exercise_title: tmpl.title,
            category: classified.category,
            increment_kg: classified.increment_kg,
            fatigue_weight: classified.fatigue_weight,
            recovery_hours: classified.recovery_hours,
            muscle_groups: classified.muscle_groups,
          });
          configCount++;
        }
      }
      if (configCount > 0) ctx.log.info(`Exercise config: auto-classified ${configCount} exercises`);
    } catch (err) {
      ctx.log.warn(`Exercise config sync failed: ${err.message}`);
    }

    // ── Check exercise progressions ───────────────────────────────────────
    try {
      checkProgressions(ctx.config, ctx.log);
    } catch (err) {
      ctx.log.warn(`Progression check failed: ${err.message}`);
    }

    // ── Compute muscle fatigue ────────────────────────────────────────────
    try {
      const startDate7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const fatigueWorkouts = getCachedWorkouts(ctx.config, startDate7, today);
      const configs = getAllExerciseConfigs(ctx.config);
      const configMap = new Map(configs.map(c => [c.exercise_title, c]));
      const templates = getAllExerciseTemplates(ctx.config);
      const templateMap = new Map(templates.map(t => [t.title, t]));

      const fatigue = computeMuscleFatigue(fatigueWorkouts, configMap, templateMap);
      if (Object.keys(fatigue).length > 0) {
        updateMuscleFatigue(ctx.config, today, fatigue);
        ctx.log.info(`Muscle fatigue computed: ${Object.entries(fatigue).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
    } catch (err) {
      ctx.log.warn(`Muscle fatigue computation failed: ${err.message}`);
    }

    // (Feedback prompt removed 2026-05-23 per Mark's direction.)

    ctx.log.info(`Daily sync complete. Readiness: ${readiness}`);
  },
};

/**
 * Check double progression status for all exercises in the active program.
 */
function checkProgressions(config, log) {
  const program = getActiveProgram(config);
  if (!program) return;

  let programData;
  try {
    programData = JSON.parse(program.program_json);
  } catch { return; }

  const today = new Date().toISOString().slice(0, 10);
  const recentStart = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const recentWorkouts = getCachedWorkouts(config, recentStart, today);
  if (recentWorkouts.length === 0) return;

  let updated = 0;

  for (const [, session] of Object.entries(programData.weekly_template || {})) {
    for (const ex of (session.exercises || [])) {
      // Find matching workout exercise from recent synced data
      let matchedSets = null;
      let matchedTopWeight = 0;

      for (const w of recentWorkouts) {
        const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
        for (const wEx of exercises) {
          if (wEx.title?.toLowerCase().includes(ex.name.toLowerCase())) {
            const normalSets = (wEx.sets || []).filter(s => s.type === 'normal');
            if (normalSets.length > 0) {
              matchedSets = normalSets;
              matchedTopWeight = Math.max(...normalSets.map(s => s.weight_kg || 0));
            }
            break;
          }
        }
        if (matchedSets) break;
      }

      if (!matchedSets) continue;

      const topRep = parseInt(ex.rep_range?.split('-')[1]) || parseInt(ex.rep_range) || 10;
      const hitsTop = matchedSets.filter(s => s.reps >= topRep).length;
      const threshold = Math.ceil(matchedSets.length * 0.75); // supermajority

      const configRow = getExerciseConfig(config, ex.name);
      const increment = configRow?.increment_kg ?? 2.5;

      const existing = getExerciseProgression(config, ex.name, program.id);

      if (hitsTop >= threshold) {
        // Progression triggered
        const newWeight = increment > 0
          ? (existing?.current_weight_kg || matchedTopWeight) + increment
          : null; // bodyweight: no weight change

        upsertExerciseProgression(config, {
          exercise_title: ex.name,
          program_id: program.id,
          current_weight_kg: newWeight,
          prescribed_rep_range: ex.rep_range,
          last_sets_json: JSON.stringify(matchedSets),
          consecutive_top_count: (existing?.consecutive_top_count || 0) + 1,
          status: 'progressing',
          stall_weeks: 0,
        });
        updated++;
      } else {
        // Check for stall
        const stallWeeks = (existing?.stall_weeks || 0) + 1;
        upsertExerciseProgression(config, {
          exercise_title: ex.name,
          program_id: program.id,
          current_weight_kg: existing?.current_weight_kg || matchedTopWeight,
          prescribed_rep_range: ex.rep_range,
          last_sets_json: JSON.stringify(matchedSets),
          consecutive_top_count: 0,
          status: stallWeeks >= 3 ? 'stalled' : 'active',
          stall_weeks: stallWeeks,
        });
        updated++;
      }
    }
  }

  if (updated > 0) log.info(`Progression check: ${updated} exercises updated`);
}

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
