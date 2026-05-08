/**
 * Cron handler: morning_workout
 *
 * 7am ET — Shows recovery prompt with time buttons.
 * Also exported as sendWorkoutPrompt for /workout command
 * and generateAdaptedWorkout for callback/tool usage.
 */
import {
  ensureDb, getActiveProgram, getRecoveryForDate,
  getCachedWorkouts, getOnboardingAnalysis, savePendingWorkout,
  refreshWhoopRecovery,
  getExerciseProgression, getProgressionForProgram,
  getRecentFeedback, getWeeklyAdjustment,
  getRecoveryRange, getAllExerciseTemplates,
} from '../lib/db.js';
import { callSonnet } from '../lib/claude.js';
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

    try {
      await sendWorkoutPrompt(ctx, chatId);
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

  // No program → check for onboarding analysis
  if (!program) {
    const analysis = getOnboardingAnalysis(ctx.config);

    if (analysis?.status === 'complete' && analysis.narrative) {
      await ctx.adapter.send({ chatId, text: analysis.narrative });

      const inferred = analysis.inferred_goals_json
        ? JSON.parse(analysis.inferred_goals_json) : [];
      if (inferred.length > 0) {
        const goalList = inferred.map((g, i) => `${i + 1}. ${g.goal_text}`).join('\n');
        await ctx.adapter.send({
          chatId,
          text: `Based on your history, I'd suggest these goals:\n${goalList}\n\nDoes this look right?`,
          inlineKeyboard: [[
            { text: 'Confirm', callbackData: 'ob:confirm' },
            { text: 'Adjust', callbackData: 'ob:adjust' },
            { text: 'Start fresh', callbackData: 'ob:fresh' },
          ]],
        });
      }
    } else if (analysis?.status === 'pending') {
      await ctx.adapter.send({
        chatId,
        text: "I'm still analyzing your workout history. I'll send your training profile soon.",
      });
    } else {
      await ctx.adapter.send({
        chatId,
        text: "Hey! I'm your trainer. You don't have a program set up yet.\n\nTell me what you're training for, or type /goals to get started.",
      });
    }
    return;
  }

  // Extract today's session from program
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  let programData;
  try {
    programData = JSON.parse(program.program_json);
  } catch {
    await ctx.adapter.send({ chatId, text: 'Program data is corrupted. Use /program new to create a fresh one.' });
    return;
  }

  const session = programData.weekly_template?.[dayName];

  // Pull recovery data (needed for both training and rest-day paths)
  const today = new Date().toISOString().slice(0, 10);
  const recovery = getRecoveryForDate(ctx.config, today);
  const readiness = recovery?.combined_readiness || 'unknown';

  // Recovery summary line
  const recoveryParts = [];
  if (recovery) {
    if (recovery.whoop_recovery_score != null) recoveryParts.push(`Whoop ${recovery.whoop_recovery_score}%`);
    if (recovery.whoop_hrv != null) recoveryParts.push(`HRV ${Math.round(recovery.whoop_hrv)}ms`);
    if (recovery.eightsleep_sleep_score != null) recoveryParts.push(`8Sleep ${recovery.eightsleep_sleep_score}`);
  }
  const recoverySummary = recoveryParts.length > 0 ? recoveryParts.join(' | ') : 'No recovery data';

  if (!session && options.source !== 'command') {
    // Cron path: send rest day info and stop
    await ctx.adapter.send({
      chatId,
      text: `*Rest day* (${dayName})\n\nNo training scheduled. Focus on recovery, mobility, or light cardio.`,
      parseMode: 'Markdown',
    });
    return;
  }

  if (!session) {
    // Command on rest day: show recovery session with time buttons
    const card = [
      `*Recovery Session* — ${dayName}`,
      recoverySummary,
      '',
      "Rest day on the program, but I'll build you a light session.",
      'How much time do you have?',
    ].filter(Boolean).join('\n');

    await ctx.adapter.send({
      chatId,
      text: card,
      parseMode: 'Markdown',
      inlineKeyboard: [[
        { text: '30m', callbackData: 'wt:30' },
        { text: '45m', callbackData: 'wt:45' },
        { text: '60m', callbackData: 'wt:60' },
        { text: '90m', callbackData: 'wt:90' },
      ]],
    });

    ctx.store.set('mode', 'workout-time-ask');
    return;
  }

  // Readiness emoji + adjustment note
  const readinessEmoji = readiness === 'green' ? '\u2705' : readiness === 'yellow' ? '\u26a0\ufe0f' : readiness === 'red' ? '\ud83d\uded1' : '\u2753';
  let adjustNote = '';
  if (readiness === 'yellow') {
    adjustNote = "\u26a0\ufe0f Yellow readiness — I'll adjust intensity down.";
  } else if (readiness === 'red') {
    adjustNote = "\ud83d\uded1 Red readiness — I'll program active recovery.";
  }

  const card = [
    `${readinessEmoji} *${session.name}* — Week ${program.current_week}`,
    recoverySummary,
    adjustNote,
    '',
    'How much time do you have?',
  ].filter(Boolean).join('\n');

  await ctx.adapter.send({
    chatId,
    text: card,
    parseMode: 'Markdown',
    inlineKeyboard: [[
      { text: '30m', callbackData: 'wt:30' },
      { text: '45m', callbackData: 'wt:45' },
      { text: '60m', callbackData: 'wt:60' },
      { text: '90m', callbackData: 'wt:90' },
    ]],
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
    await ctx.adapter.send({ chatId, text: 'No active program. Use /program new to create one.' });
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

  // Pull recovery data (needed for both training and rest-day paths)
  const today = new Date().toISOString().slice(0, 10);
  const recovery = getRecoveryForDate(ctx.config, today);
  const readiness = recovery?.combined_readiness || 'unknown';

  // Recovery context
  const recoveryParts = [];
  if (recovery) {
    if (recovery.whoop_recovery_score != null) recoveryParts.push(`Whoop ${recovery.whoop_recovery_score}%`);
    if (recovery.whoop_hrv != null) recoveryParts.push(`HRV ${Math.round(recovery.whoop_hrv)}ms`);
    if (recovery.eightsleep_sleep_score != null) recoveryParts.push(`8Sleep ${recovery.eightsleep_sleep_score}`);
  }

  if (isRestDayWorkout) {
    const source = ctx.store.get('workout_source');
    ctx.store.set('workout_source', null);
    if (source !== 'command') {
      await ctx.adapter.send({
        chatId,
        text: `*Rest day* (${dayName})\n\nNo training scheduled.`,
        parseMode: 'Markdown',
      });
      return;
    }
  }

  // Pull recent weight data for exercise history
  const startDate14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const recentWorkouts = getCachedWorkouts(ctx.config, startDate14, today);

  // ── Gather new context (feedback, fatigue, deload) ─────────────────────
  let feedbackContext = '';
  let fatigueContext = '';
  let deloadOverride = '';

  try {
    // Recent feedback summary
    const feedback = getRecentFeedback(ctx.config, 3);
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
    const allExercises = [];
    for (const daySession of Object.values(programData.weekly_template || {})) {
      for (const ex of (daySession.exercises || [])) {
        if (!allExercises.find(e => e.name === ex.name)) {
          allExercises.push(ex);
        }
      }
    }
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

  const result = await callSonnet(systemPrompt, userMessage);

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

  await ctx.adapter.send({
    chatId,
    text: workoutCard,
    parseMode: 'Markdown',
    inlineKeyboard: [buttons],
  });
}
