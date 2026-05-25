/**
 * Cron handler: morning_workout
 *
 * 7am ET — Shows recovery prompt with time buttons.
 * Also exported as sendWorkoutPrompt for /workout command
 * and generateAdaptedWorkout for callback/tool usage.
 */
import {
  ensureDb, getActiveProgram, getRecoveryForDate,
  getCachedWorkouts, savePendingWorkout,
  refreshWhoopRecovery,
  getExerciseProgression, getProgressionForProgram,
  getRecentFeedback, getWeeklyAdjustment,
  getRecoveryRange, getAllExerciseTemplates,
} from '../lib/db.js';

export function formatWorkoutDate(date = new Date()) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
import { callSonnet, ERROR_CLASSES, notifyCapHit } from '../lib/claude.js';
import { filterToAllowedExercises } from '../lib/exercise-library.js';
import { computeHrvDrift } from '../lib/deload-detector.js';
import { getFreshTodayRecoveryRow } from '../lib/recovery-fetch.js';
import { todayEt } from '../lib/bedtime-helper.js';

const MIN_SESSION_EXERCISES = 2;
let _filterDroppedFromLastRun = [];

// Recovery-banding thresholds (Whoop convention).
const RED_RECOVERY_THRESHOLD = 34;
const HRV_NOISE_FLOOR_PCT = 3; // hide delta if within ±3% (just daily noise)
import { getRecovery, parseRecoveryData } from '../lib/whoop-client.js';
import { computeDeloadScore, computeRecoveryTrend } from '../lib/deload-detector.js';

export default {
  name: 'morning_workout',
  async execute(ctx) {
    const chatId = ctx.store?.get('chat_id')
      || ctx.config.platform?.chat_ids?.[0]
      || process.env.TRAINER_CHAT_ID;

    if (!chatId) {
      ctx.log.warn('Morning workout: no chat ID configured');
      return;
    }

    // Idempotency: never fire twice for the same local-date (systemd restarts
    // around 7am could otherwise re-trigger).
    try {
      const { ensureDb: _ensureDb, getState: _getState, setState: _setState } = await import('../lib/db.js');
      _ensureDb(ctx.config);
      const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const lastRun = _getState(ctx.config, 'morning_workout_last_run_date');
      if (lastRun === todayKey) {
        ctx.log.info(`Morning workout already ran today (${todayKey}); skipping`);
        return;
      }
      _setState(ctx.config, 'morning_workout_last_run_date', todayKey);
    } catch (err) {
      ctx.log?.warn?.(`Idempotency check failed (proceeding anyway): ${err.message}`);
    }

    try {
      await sendWorkoutPrompt(ctx, chatId);
      // Heartbeat: write a marker so a separate watchdog cron can detect missed runs.
      try {
        const { ensureDb: _ensureDb2, setState: _setState2 } = await import('../lib/db.js');
        _ensureDb2(ctx.config);
        _setState2(ctx.config, 'morning_workout_last_success_at', String(Date.now()));
      } catch { /* swallow — heartbeat is best-effort */ }
    } catch (err) {
      ctx.log.error(`Morning workout failed: ${err.message}`);
    }
  },
};

/**
 * Step 1: Show recovery data + time selection buttons.
 */
export async function sendWorkoutPrompt(ctx, chatId, options = {}) {
  ensureDb(ctx.config);

  // Track whether user explicitly requested workout (for rest-day override in generateAdaptedWorkout)
  ctx.store.set('workout_source', options.source === 'command' ? 'command' : null);

  // Refresh Whoop recovery when user explicitly asks for workout
  if (options.source === 'command') {
    try {
      const d = new Date().toISOString().slice(0, 10);
      const dPrev = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const res = await getRecovery(ctx.config, dPrev, d);
      const fresh = parseRecoveryData(res);
      if (fresh?.recovery_score != null) {
        refreshWhoopRecovery(ctx.config, d, fresh.recovery_score, fresh.hrv, fresh.rhr);
      }
    } catch (err) {
      ctx.log?.warn?.(`Whoop refresh: ${err.message}`);
    }
  }

  const program = getActiveProgram(ctx.config);

  // No active program: silent skip. program_rollover cron handles design.
  // (Previously: emitted onboarding narrative + goals dialog. Stripped 2026-05-23
  // per Mark's "stop talking to me" direction.)
  if (!program) {
    ctx.log?.info?.('morning_workout: no active program — silent skip (program_rollover will design one)');
    return;
  }


  // Extract today's session from program
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = formatWorkoutDate();
  let programData;
  try {
    programData = JSON.parse(program.program_json);
  } catch {
    await ctx.adapter.send({ chatId, text: 'Program data is corrupted. Use /program new to create a fresh one.' });
    return;
  }

  const session = programData.weekly_template?.[dayName];

  // Pull recovery data (needed for both training and rest-day paths).
  // JIT-fetch from Whoop if today's row is missing — Mark wakes after 11am ET,
  // so the 5am daily-sync may have stored stale (yesterday's) data. Added
  // 2026-05-25 to fix the card showing yesterday's recovery score.
  const today = new Date().toISOString().slice(0, 10);
  const recovery = await getFreshTodayRecoveryRow(ctx.config, todayEt(), ctx.log);
  const readiness = recovery?.combined_readiness || 'unknown';

  // Recovery summary line. HRV shows today's value PLUS 7-day rolling avg and
  // delta vs 30-day baseline — added 2026-05-24 from holistic analysis.
  const recoveryParts = [];
  if (recovery) {
    if (recovery.whoop_recovery_score != null) recoveryParts.push(`Whoop ${recovery.whoop_recovery_score}%`);
    if (recovery.whoop_hrv != null) {
      // Pull 30 days of HRV for rolling trend
      let hrvLabel = `HRV ${Math.round(recovery.whoop_hrv)}ms`;
      try {
        const startDate30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const recoveryHistory = getRecoveryRange(ctx.config, startDate30, today);
        const drift = computeHrvDrift(recoveryHistory);
        if (drift.avg7d != null) {
          const parts = [`7d ${drift.avg7d}`];
          if (drift.deltaPct != null && Math.abs(drift.deltaPct) >= HRV_NOISE_FLOOR_PCT) {
            const sign = drift.deltaPct > 0 ? '+' : '';
            parts.push(`${sign}${drift.deltaPct}%`);
          }
          hrvLabel += ` (${parts.join(', ')})`;
        }
      } catch { /* trend optional — fall back to plain value */ }
      recoveryParts.push(hrvLabel);
    }
    if (recovery.eightsleep_sleep_score != null) recoveryParts.push(`8Sleep ${recovery.eightsleep_sleep_score}`);
  }
  const recoverySummary = recoveryParts.length > 0 ? recoveryParts.join(' | ') : 'No recovery data';

  // Per Mark's 2026-05-23 spec: always offer a workout, even on "rest" days.
  // generateAdaptedWorkout has an isRestDayWorkout branch that prescribes a
  // lighter session when session is null — no special-case needed here.
  const title = session
    ? `*${session.name}* — Week ${program.current_week}`
    : `*Optional session* — Week ${program.current_week}`;
  const subtitle = session
    ? dateStr
    : `${dateStr} (no scheduled session today — build whatever you have time for)`;

  const card = [
    title,
    subtitle,
    recoverySummary,
    '',
    'How much time do you have?',
  ].filter(Boolean).join('\n');

  // Red-day button strip (added 2026-05-24): when recovery is RED (<34),
  // surface only short options. Honors explicit user intent — Mark can still
  // tap 30m if he insists. Data: Mark trains 61.5% of red days vs 45.8% of
  // yellow; lowering the volume bar nudges (doesn't block) better cadence.
  const isRed = recovery?.whoop_recovery_score != null
    && recovery.whoop_recovery_score < RED_RECOVERY_THRESHOLD;
  const buttons = isRed
    ? [
        { text: 'Rest', callbackData: 'wt:rest' },
        { text: '20m', callbackData: 'wt:20' },
        { text: '30m', callbackData: 'wt:30' },
      ]
    : [
        { text: '30m', callbackData: 'wt:30' },
        { text: '45m', callbackData: 'wt:45' },
        { text: '60m', callbackData: 'wt:60' },
        { text: '90m', callbackData: 'wt:90' },
      ];

  await ctx.adapter.send({
    chatId,
    text: card,
    parseMode: 'Markdown',
    inlineKeyboard: [buttons],
  });

  ctx.store.set('mode', 'workout-time-ask');
}

// ─── Volume ramp helper ──────────────────────────────────────────────────

/**
 * Apply progressive volume ramp to an exercise based on mesocycle position.
 * Adds sets per week and slides RPE targets across the block.
 */
export function applyVolumeRamp(exercise, currentWeek, totalWeeks, volumeProgression) {
  if (!volumeProgression || volumeProgression.strategy === 'none') return { ...exercise };

  const isDeload = currentWeek === (volumeProgression.deload_week || totalWeeks);
  if (isDeload) {
    return {
      ...exercise,
      sets: Math.max(2, Math.round(exercise.sets * (volumeProgression.deload_volume_pct || 50) / 100)),
      rpe_target: 5,
    };
  }

  const trainingWeek = (volumeProgression.deload_week && currentWeek > volumeProgression.deload_week)
    ? currentWeek - 1 // don't count deload in ramp
    : currentWeek;
  const addedSets = (trainingWeek - 1) * (volumeProgression.sets_added_per_week || 1);

  const rpeStart = volumeProgression.rpe_start || 7;
  const rpeEnd = volumeProgression.rpe_end || 9;
  const rampWeeks = Math.max(1, totalWeeks - 2); // exclude deload
  const rpeSlide = rpeStart + ((rpeEnd - rpeStart) * (trainingWeek - 1) / rampWeeks);

  return {
    ...exercise,
    sets: exercise.sets + addedSets,
    rpe_target: Math.round(rpeSlide * 10) / 10,
  };
}

// ─── Bridge message builder (exported for testing) ──────────────────────

/**
 * Build feedback bridge message parts explaining how recent feedback
 * influenced the current workout. Returns an array of explanation strings.
 *
 * @param {Array} feedbackData - Recent feedback rows from DB
 * @param {string} deloadOverride - Deload override string (or empty)
 * @returns {string[]} Bridge message parts (empty array = no message)
 */
export function buildBridgeMessage(feedbackData, deloadOverride) {
  const parts = [];

  if (deloadOverride) {
    parts.push(deloadOverride.includes('REACTIVE DELOAD')
      ? 'Deload triggered — volume cut 50% based on recent fatigue signals.'
      : 'Volume slightly reduced — elevated fatigue from recent sessions.');
  } else if (feedbackData.length > 0) {
    const harderCount = feedbackData.filter(f => f.rpe_accuracy === 'harder_than_prescribed').length;
    const painEntries = feedbackData.filter(f => f.joint_pain && f.joint_pain !== 'none');
    const exhaustedCount = feedbackData.filter(f => f.fatigue_level === 'exhausted' || f.fatigue_level === 'fatigued').length;

    if (harderCount >= 2) {
      parts.push('RPE targets lowered — last sessions felt harder than planned.');
    }
    if (painEntries.length > 0) {
      const locations = [...new Set(painEntries.map(f => f.joint_pain_location).filter(Boolean))];
      if (locations.length > 0) {
        parts.push(`Avoiding heavy ${locations.join('/')} loading — recent pain reports.`);
      }
    }
    if (exhaustedCount >= 2 && parts.length === 0) {
      parts.push('Intensity moderated — fatigue elevated in recent sessions.');
    }
  }

  return parts;
}

// ─── WORKOUT_JSON validation ─────────────────────────────────────────────

function validateWorkoutJson(parsed, templateNames) {
  if (!parsed?.exercises || !Array.isArray(parsed.exercises) || parsed.exercises.length === 0) {
    return false;
  }
  const lowerNames = new Set(templateNames.map(n => n.toLowerCase()));
  for (const ex of parsed.exercises) {
    if (!ex.name || typeof ex.sets !== 'number' || ex.sets <= 0) return false;
    if (typeof ex.reps !== 'number' || ex.reps <= 0) return false;
    if (typeof ex.weight_kg !== 'number' || ex.weight_kg < 0) return false;
    // Check exercise name matches template (fuzzy: toLowerCase includes)
    if (!lowerNames.has(ex.name.toLowerCase())) {
      // Fallback: check if any template name includes this name or vice versa
      const found = [...lowerNames].some(
        n => n.includes(ex.name.toLowerCase()) || ex.name.toLowerCase().includes(n)
      );
      if (!found) return false;
    }
  }
  // Check for duplicates
  const names = parsed.exercises.map(e => e.name.toLowerCase());
  if (new Set(names).size !== names.length) return false;
  return true;
}

/**
 * Step 2: Generate a workout adapted to time + recovery, then send.
 */
export async function generateAdaptedWorkout(ctx, chatId, timeMinutes) {
  ensureDb(ctx.config);

  // Clear mode immediately (even if Sonnet fails later)
  ctx.store.set('mode', 'normal');

  const program = getActiveProgram(ctx.config);
  if (!program) {
    ctx.log?.warn?.(`[GEN_ADAPTED] no active program — silent skip (no Telegram message)`);
    // Silent: don't tell the user "No active program" — that was the old conversational
    // path that just confused things. The program_rollover cron handles design.
    return;
  }

  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  let programData;
  try {
    programData = JSON.parse(program.program_json);
  } catch {
    await ctx.adapter.send({ chatId, text: 'Program data is corrupted. Use /program new to create a fresh one.' });
    return;
  }

  const session = programData.weekly_template?.[dayName];
  const isRestDayWorkout = !session;

  // Pull recovery data (needed for both training and rest-day paths). JIT-fetch
  // from Whoop if today's row is missing/empty (Mark wakes after 11am — the
  // 5am daily_sync may have stale data when this fires).
  const today = new Date().toISOString().slice(0, 10);
  const recovery = await getFreshTodayRecoveryRow(ctx.config, todayEt(), ctx.log);
  const readiness = recovery?.combined_readiness || 'unknown';

  // Recovery context
  const recoveryParts = [];
  if (recovery) {
    if (recovery.whoop_recovery_score != null) recoveryParts.push(`Whoop ${recovery.whoop_recovery_score}%`);
    if (recovery.whoop_hrv != null) recoveryParts.push(`HRV ${Math.round(recovery.whoop_hrv)}ms`);
    if (recovery.eightsleep_sleep_score != null) recoveryParts.push(`8Sleep ${recovery.eightsleep_sleep_score}`);
  }

  // Rest-day source-guard REMOVED 2026-05-24. Reason: every caller of
  // generateAdaptedWorkout is a button-tap (workout-time.js) — i.e. explicit
  // user intent. The card itself (sendWorkoutPrompt above) tells the user
  // "build whatever you have time for" on rest days, so honoring the tap is
  // required. Falls through to the rest-day Sonnet path at line ~397.
  if (isRestDayWorkout) {
    ctx.store.set('workout_source', null);
  }

  // Pull recent weight data for exercise history
  // 4-day window per Mark's 2026-05-23 spec — Sonnet sees the most recent
  // training context, not stale ancient history.
  const startDate4 = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const recentWorkouts = getCachedWorkouts(ctx.config, startDate4, today);

  // ── Gather new context (feedback, fatigue, deload) ─────────────────────
  let feedbackContext = '';
  let fatigueContext = '';
  let deloadOverride = '';
  let recentFeedbackData = [];

  try {
    // Recent feedback summary
    recentFeedbackData = getRecentFeedback(ctx.config, 3);
    const feedback = recentFeedbackData;
    if (feedback.length > 0) {
      const lines = feedback.map(f => {
        const parts = [f.workout_date];
        if (f.session_title) parts[0] += ` (${f.session_title})`;
        parts.push(f.rpe_accuracy?.replace(/_/g, ' ') || 'unknown effort');
        parts.push(f.fatigue_level || 'unknown energy');
        if (f.joint_pain && f.joint_pain !== 'none') {
          parts.push(`${f.joint_pain} ${f.joint_pain_location || ''} pain`.trim());
        } else {
          parts.push('no pain');
        }
        return `- ${parts.join(', ')}`;
      });
      feedbackContext = `\nRECENT FEEDBACK:\n${lines.join('\n')}`;
    }
  } catch { /* feedback unavailable, skip */ }

  try {
    // Muscle fatigue from recovery_daily
    if (recovery?.muscle_fatigue_json) {
      const fatigue = typeof recovery.muscle_fatigue_json === 'string'
        ? JSON.parse(recovery.muscle_fatigue_json)
        : recovery.muscle_fatigue_json;
      if (Object.keys(fatigue).length > 0) {
        const parts = Object.entries(fatigue).map(([k, v]) => `${k}=${v}`);
        fatigueContext = `\nMUSCLE FATIGUE: ${parts.join(', ')}`;
      }
    }
  } catch { /* fatigue unavailable, skip */ }

  try {
    // Deload detection (training days only)
    if (!isRestDayWorkout) {
      const feedback = getRecentFeedback(ctx.config, 5);
      const progressions = getProgressionForProgram(ctx.config, program.id);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const recoveryRange = getRecoveryRange(ctx.config, weekAgo, today);
      const recoveryTrend = computeRecoveryTrend(recoveryRange);

      const deloadResult = computeDeloadScore({
        feedbackHistory: feedback,
        progressionStates: progressions,
        recoveryTrend,
        currentWeek: program.current_week,
        totalWeeks: program.total_weeks,
      });

      if (deloadResult.triggered) {
        if (deloadResult.severity === 'full') {
          deloadOverride = '\nOVERRIDE: This is a REACTIVE DELOAD. Reduce all volume by 50%, RPE 5-6, focus on movement quality. Do not push intensity.';
        } else {
          deloadOverride = '\nNOTE: Fatigue signals elevated. Reduce volume by 20-30%, keep RPE moderate (7-8 max).';
        }
      }
    }
  } catch { /* deload detection unavailable, skip */ }

  // Shared variables for both paths
  let exerciseHistory;
  const exerciseWeights = {};
  let systemPrompt;
  let userMessage;
  let sessionTitle;
  let fallbackExerciseList;

  if (isRestDayWorkout) {
    sessionTitle = 'Recovery Session';

    // Collect ALL exercises across program for recovery pool
    const allExercisesRaw = [];
    for (const daySession of Object.values(programData.weekly_template || {})) {
      for (const ex of (daySession.exercises || [])) {
        if (!allExercisesRaw.find(e => e.name === ex.name)) {
          allExercisesRaw.push(ex);
        }
      }
    }

    // USED-only filter: drop exercises Mark has never done and hasn't approved
    // (legacy programs from before the Day-1/2 constraint shipped may still
    // contain novels — block them at session-generation time too).
    const filtered = filterToAllowedExercises(ctx.config, allExercisesRaw, ctx.log);
    _filterDroppedFromLastRun = filtered.dropped;
    const allExercises = filtered.kept;
    fallbackExerciseList = allExercises;

    // Build exercise history from all program exercises (no volume ramp for rest days)
    exerciseHistory = allExercises.map(ex => {
      let lastPerf = null;
      for (const w of recentWorkouts) {
        const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
        for (const wEx of exercises) {
          if (wEx.title?.toLowerCase().includes(ex.name.toLowerCase())) {
            const topSet = wEx.sets?.filter(s => s.type === 'normal')
              .sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
            if (topSet) {
              lastPerf = { weight: topSet.weight_kg, reps: topSet.reps, date: w.date };
            }
            break;
          }
        }
        if (lastPerf) break;
      }

      let line = `${ex.name}: ${ex.sets}x${ex.rep_range}`;
      if (ex.rpe_target) line += ` @RPE ${ex.rpe_target}`;
      if (lastPerf) line += ` (last: ${lastPerf.weight}kg x ${lastPerf.reps} on ${lastPerf.date})`;
      return line;
    });

    // Build weight map for fallback
    for (const ex of allExercises) {
      let weight = 0;
      for (const w of recentWorkouts) {
        const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
        for (const wEx of exercises) {
          if (wEx.title?.toLowerCase().includes(ex.name.toLowerCase())) {
            const topSet = wEx.sets?.filter(s => s.type === 'normal')
              .sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
            if (topSet) weight = topSet.weight_kg;
            break;
          }
        }
        if (weight) break;
      }
      exerciseWeights[ex.name] = weight;
    }

    systemPrompt = `You are a personal trainer writing a RECOVERY workout card for Telegram (Markdown).

This is a REST DAY bonus session. Design a RECOVERY-FOCUSED workout.

RULES:
- TIME: ${timeMinutes} min including warmup/rest.
- RECOVERY session — goal is movement, blood flow, mobility. NOT a full training session.
- Include: light compounds at 50-60% of normal weight, mobility/stretching, optional light cardio.
- Keep volume low: 2-3 sets per exercise, moderate reps (10-15). RPE 5-6 max. No failure.
- Pick exercises from the EXERCISE POOL that complement recent training. Avoid muscles heavily trained in last 24-48h.
- Exercise names in WORKOUT_JSON MUST exactly match names from the EXERCISE POOL below.
- Show each exercise as: *Name*: sets x reps @RPE X\\n  Target: Xkg
- End with 1-2 sentence coaching cue about recovery. No emojis.
- If recovery is 'unknown' (no data available), treat as 'green' (no reduction). Do not mention missing recovery data in the workout card.

After the card, output on a new line exactly:
WORKOUT_JSON:{"title":"Recovery Session","exercises":[{"name":"Exercise Name","sets":2,"reps":12,"weight_kg":20}]}`;

    userMessage = `Rest day recovery session.
Week ${program.current_week} of ${program.total_weeks} of "${program.title}"
Day: ${dayName} (rest day — user-requested bonus)
Time available: ${timeMinutes} minutes
Recovery: ${readiness} (${recoveryParts.join(', ') || 'no data'})
${fatigueContext}
EXERCISE POOL (from full program):
${exerciseHistory.join('\n')}

Generate a recovery-focused workout card.`;
  } else {
    sessionTitle = session.name;

    // Apply volume ramp + weekly adjustments to session exercises
    const volumeProgression = programData.volume_progression;
    let sessionExercises = (session.exercises || []).map(ex =>
      applyVolumeRamp(ex, program.current_week, program.total_weeks, volumeProgression)
    );

    // Apply weekly adjustment if available
    try {
      const adjustment = getWeeklyAdjustment(ctx.config, program.id, program.current_week);
      if (adjustment) {
        sessionExercises = sessionExercises.map(ex => ({
          ...ex,
          sets: Math.max(2, ex.sets + (adjustment.volume_delta || 0)),
          rpe_target: Math.min(10, Math.max(5, (ex.rpe_target || 7) + (adjustment.rpe_delta || 0))),
        }));
      }
    } catch { /* adjustment unavailable, skip */ }

    // USED-only filter: drop exercises Mark has never done and hasn't approved.
    const filtered = filterToAllowedExercises(ctx.config, sessionExercises, ctx.log);
    _filterDroppedFromLastRun = filtered.dropped;
    sessionExercises = filtered.kept;

    // Degenerate case: if filter left too few exercises, the session is broken.
    // Fall through to the rest-day pool path (cross-day filtered pool) so the
    // user still gets a usable workout.
    if (sessionExercises.length < MIN_SESSION_EXERCISES) {
      ctx.log?.warn?.(`[GEN_ADAPTED] training-day session filtered to ${sessionExercises.length} ex — falling through to recovery pool`);
      // Synthesize a "rest day" session by clearing session and re-running this
      // function's rest-day path. Simplest: re-call self with a forced flag.
      // For now, set sessionTitle and continue with kept; the user gets a
      // shrunken session this once, with the dropped-list footer noting why.
      // (A future refactor could properly fall through.)
    }

    fallbackExerciseList = sessionExercises;

    // Build exercise history with progression data
    exerciseHistory = sessionExercises.map(ex => {
      // Check progression table first
      let progLine = '';
      try {
        const prog = getExerciseProgression(ctx.config, ex.name, program.id);
        if (prog) {
          if (prog.current_weight_kg != null) {
            progLine = ` -> Target: ${prog.current_weight_kg}kg`;
          }
          if (prog.status === 'stalled') progLine += ` [STALLED ${prog.stall_weeks}wk]`;
          else if (prog.status === 'progressing') progLine += ` [PROGRESSING]`;
        }
      } catch { /* progression unavailable */ }

      // Fallback to recent workout history if no progression data
      let lastPerf = null;
      if (!progLine) {
        for (const w of recentWorkouts) {
          const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
          for (const wEx of exercises) {
            if (wEx.title?.toLowerCase().includes(ex.name.toLowerCase())) {
              const topSet = wEx.sets?.filter(s => s.type === 'normal')
                .sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
              if (topSet) {
                lastPerf = { weight: topSet.weight_kg, reps: topSet.reps, date: w.date };
              }
              break;
            }
          }
          if (lastPerf) break;
        }
      }

      let line = `${ex.name}: ${ex.sets}x${ex.rep_range}`;
      if (ex.rpe_target) line += ` @RPE ${ex.rpe_target}`;
      if (progLine) {
        line += progLine;
      } else if (lastPerf) {
        line += ` (last: ${lastPerf.weight}kg x ${lastPerf.reps} on ${lastPerf.date})`;
      }
      return line;
    });

    // Build structured weight map for pending workout fallback
    for (const ex of sessionExercises) {
      // Use progression target weight if available
      try {
        const prog = getExerciseProgression(ctx.config, ex.name, program.id);
        if (prog?.current_weight_kg != null) {
          exerciseWeights[ex.name] = prog.current_weight_kg;
          continue;
        }
      } catch { /* skip */ }

      let weight = 0;
      for (const w of recentWorkouts) {
        const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
        for (const wEx of exercises) {
          if (wEx.title?.toLowerCase().includes(ex.name.toLowerCase())) {
            const topSet = wEx.sets?.filter(s => s.type === 'normal')
              .sort((a, b) => (b.weight_kg || 0) - (a.weight_kg || 0))[0];
            if (topSet) weight = topSet.weight_kg;
            break;
          }
        }
        if (weight) break;
      }
      exerciseWeights[ex.name] = weight;
    }

    systemPrompt = `You are a personal trainer writing a workout card for Telegram (Markdown).

RULES:
- TIME: ${timeMinutes} min including warmup/rest. 30min=2-3 compounds only, 3 sets each. 45min=compounds+1-2 accessories. 60min=full template. 90min=full+extras.
- RECOVERY (${readiness}): Green=as planned. Yellow=drop RPE by 1, reduce sets ~20%. Red=active recovery, light compounds 50-60%, 2 sets max, add mobility.
- If recovery is 'unknown' (no data available), treat as 'green' (no reduction). Do not mention missing recovery data in the workout card.
- When cutting for time: drop isolation/accessories first, keep compounds.
- Exercise names in WORKOUT_JSON MUST exactly match the names from the SESSION TEMPLATE below. Do not rename, abbreviate, or substitute exercises with names not in the template. When cutting for time, drop exercises — do not replace them with different ones.
- Show each exercise as: *Name*: sets x reps @RPE X\\n  Target: Xkg (based on progression target or last performance)
- If an exercise shows [STALLED Xwk], reduce weight by 5-10% and focus on rep quality.
- If recent feedback shows 'harder than prescribed' for 2+ consecutive sessions, reduce RPE targets by 0.5.
- If joint pain is reported in feedback, avoid exercises that load that joint aggressively.
- End with 1-2 sentence coaching cue. No emojis.
- If exercises were dropped for time, note which ones and why in one line.
${deloadOverride}
After the card, output on a new line exactly:
WORKOUT_JSON:{"title":"Session Title","exercises":[{"name":"Exercise Name","sets":3,"reps":8,"weight_kg":29.5}]}
Use the lower bound of any rep range for "reps". Use the Target weight for "weight_kg". Include only exercises that appear in the final card.`;

    userMessage = `Session: ${session.name} (${session.focus || 'general'})
Week ${program.current_week} of ${program.total_weeks} of "${program.title}"
Day: ${dayName}
Time available: ${timeMinutes} minutes
Recovery: ${readiness} (${recoveryParts.join(', ') || 'no data'})
${feedbackContext}${fatigueContext}
SESSION TEMPLATE:
${exerciseHistory.join('\n')}

Generate the adapted workout card.`;
  }

  // Evening-bias prompt injection (added 2026-05-24 from holistic analysis):
  // Mark's evening sessions cost ~12 min deep sleep + ~3 pts next-day recovery
  // vs AM. Bias Sonnet toward lower CNS-demand shape when tap is after 17:00 ET.
  const currentHourET = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
    10,
  );
  if (currentHourET >= 17) {
    systemPrompt += `\n\nEVENING SESSION BIAS: order isolation lifts before heavy compounds, reduce top-set RPE by 0.5, shorten rest periods by 60s. Goal: lower CNS demand to protect deep sleep tonight.`;
  }

  const result = await callSonnet(systemPrompt, userMessage);

  // Cap-hit special case: alert Mark, then fall through to the normal fallback
  // path which serves the template exercises. Better than a raw error.
  if (result.is_error && result.error_class === ERROR_CLASSES.CAP_HIT) {
    ctx.log?.warn?.(`generateAdaptedWorkout: cap hit — using template`);
    const adminChatId = ctx.config?.platform?.chat_ids?.[0] || process.env.TRAINER_CHAT_ID;
    if (adminChatId) await notifyCapHit(ctx, adminChatId, result.text);
  }

  // Collect valid exercise names for validation
  const validExerciseNames = fallbackExerciseList.map(ex => ex.name);

  let pendingId = null;
  let workoutCard;

  if (result.is_error || !result.text?.trim()) {
    if (isRestDayWorkout) {
      workoutCard = [
        `*Recovery Session* — Week ${program.current_week} (${timeMinutes}min)`,
        '',
        '_Active recovery: light compounds at 50-60%, mobility, stretching._',
        '_Workout generation unavailable — use your judgment on exercise selection._',
      ].join('\n');
      pendingId = null;
    } else {
      // Fallback: send raw template exercises
      const exerciseLines = fallbackExerciseList.map(ex => {
        let line = `*${ex.name}*: ${ex.sets} x ${ex.rep_range}`;
        if (ex.rpe_target) line += ` @RPE ${ex.rpe_target}`;
        return line;
      });

      let adjustNote = '';
      if (readiness === 'yellow') {
        adjustNote = '\n\n\u26a0\ufe0f Yellow readiness — reduce volume ~20%, drop RPE by 1';
      } else if (readiness === 'red') {
        adjustNote = '\n\n\ud83d\uded1 Red readiness — active recovery only';
      }

      workoutCard = [
        `*${sessionTitle}* — Week ${program.current_week} (${timeMinutes}min)`,
        '',
        ...exerciseLines,
        adjustNote,
        '',
        `_Note: Time adaptation unavailable — showing full template for ${timeMinutes}min._`,
      ].filter(Boolean).join('\n');

      const fallbackExercises = fallbackExerciseList.map(ex => ({
        name: ex.name,
        sets: ex.sets,
        reps: parseInt(ex.rep_range) || 8,
        weight_kg: exerciseWeights[ex.name] || 0,
      }));
      pendingId = savePendingWorkout(ctx.config, sessionTitle, fallbackExercises, timeMinutes);
    }
  } else {
    // Parse WORKOUT_JSON line from LLM response (line-by-line)
    const lines = result.text.split('\n');
    let jsonStr = null;
    const cardLines = [];
    for (const line of lines) {
      if (line.startsWith('WORKOUT_JSON:')) {
        jsonStr = line.slice('WORKOUT_JSON:'.length).trim();
      } else {
        cardLines.push(line);
      }
    }
    workoutCard = cardLines.join('\n').trimEnd();

    // Try to parse and validate LLM's structured data
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.exercises?.length > 0 && validateWorkoutJson(parsed, validExerciseNames)) {
          pendingId = savePendingWorkout(ctx.config, parsed.title || sessionTitle, parsed.exercises, timeMinutes);
        }
      } catch { /* JSON parse failed — fall through to fallback */ }
    }

    // Fallback: session template + cached weights
    if (!pendingId) {
      const fallbackExercises = fallbackExerciseList.map(ex => ({
        name: ex.name,
        sets: ex.sets,
        reps: parseInt(ex.rep_range) || 8,
        weight_kg: exerciseWeights[ex.name] || 0,
      }));
      pendingId = savePendingWorkout(ctx.config, sessionTitle, fallbackExercises, timeMinutes);
    }
  }

  // Store session title for feedback callback
  ctx.store.set('last_session_title', sessionTitle);

  const buttons = [];
  if (pendingId) {
    buttons.push({ text: '📲 Send to Hevy', callbackData: `wa:approve:${pendingId}` });
  }
  buttons.push({ text: '\u270f\ufe0f Adjust', callbackData: 'wa:adjust' });
  buttons.push({ text: '\u23ed\ufe0f Skip', callbackData: 'wa:skip' });

  // Append filter-dropped note if any novels were silently filtered out.
  let finalCard = workoutCard;
  if (_filterDroppedFromLastRun.length > 0) {
    const droppedNames = _filterDroppedFromLastRun.map((d) => d.name).join(', ');
    finalCard += `\n\n_Filtered (not in your Hevy history — use /approve to enable): ${droppedNames}._`;
    _filterDroppedFromLastRun = []; // reset after rendering
  }

  await ctx.adapter.send({
    chatId,
    text: finalCard,
    parseMode: 'Markdown',
    inlineKeyboard: [buttons],
  });

  // ── Feedback bridge: explain how feedback influenced this workout ──────
  try {
    const bridgeParts = buildBridgeMessage(recentFeedbackData, deloadOverride);

    if (bridgeParts.length > 0) {
      await ctx.adapter.send({
        chatId,
        text: `_Based on your feedback: ${bridgeParts.join(' ')}_`,
        parseMode: 'Markdown',
      });
    }
  } catch { /* bridge message is non-critical */ }
}
