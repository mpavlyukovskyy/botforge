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
} from '../lib/db.js';
import { callSonnet } from '../lib/claude.js';

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
      // Safety net: cron should never reach here, but just in case
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

    // Build exercise history from all program exercises
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

After the card, output on a new line exactly:
WORKOUT_JSON:{"title":"Recovery Session","exercises":[{"name":"Exercise Name","sets":2,"reps":12,"weight_kg":20}]}`;

    userMessage = `Rest day recovery session.
Week ${program.current_week} of ${program.total_weeks} of "${program.title}"
Day: ${dayName} (rest day — user-requested bonus)
Time available: ${timeMinutes} minutes
Recovery: ${readiness} (${recoveryParts.join(', ') || 'no data'})

EXERCISE POOL (from full program):
${exerciseHistory.join('\n')}

Generate a recovery-focused workout card.`;
  } else {
    sessionTitle = session.name;
    fallbackExerciseList = session.exercises || [];

    // Build exercise history for each exercise in the session
    exerciseHistory = (session.exercises || []).map(ex => {
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

    // Build structured weight map for pending workout fallback
    for (const ex of (session.exercises || [])) {
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
- When cutting for time: drop isolation/accessories first, keep compounds.
- Exercise names in WORKOUT_JSON MUST exactly match the names from the SESSION TEMPLATE below. Do not rename, abbreviate, or substitute exercises with names not in the template. When cutting for time, drop exercises — do not replace them with different ones.
- Show each exercise as: *Name*: sets x reps @RPE X\\n  Target: Xkg (based on last: Xkg x reps on date)
- End with 1-2 sentence coaching cue. No emojis.
- If exercises were dropped for time, note which ones and why in one line.

After the card, output on a new line exactly:
WORKOUT_JSON:{"title":"Session Title","exercises":[{"name":"Exercise Name","sets":3,"reps":8,"weight_kg":29.5}]}
Use the lower bound of any rep range for "reps". Use the Target weight for "weight_kg". Include only exercises that appear in the final card.`;

    userMessage = `Session: ${session.name} (${session.focus || 'general'})
Week ${program.current_week} of ${program.total_weeks} of "${program.title}"
Day: ${dayName}
Time available: ${timeMinutes} minutes
Recovery: ${readiness} (${recoveryParts.join(', ') || 'no data'})

SESSION TEMPLATE:
${exerciseHistory.join('\n')}

Generate the adapted workout card.`;
  }

  const result = await callSonnet(systemPrompt, userMessage);

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
      // No Hevy push for generic fallback
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

      // Build fallback pending workout from session template + cached weights
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

    // Try to parse LLM's structured data
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.exercises?.length > 0) {
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

  await ctx.adapter.send({
    chatId,
    text: workoutCard,
    parseMode: 'Markdown',
    inlineKeyboard: [
      [
        { text: '📲 Send to Hevy', callbackData: `wa:approve:${pendingId}` },
        { text: '\u270f\ufe0f Adjust', callbackData: 'wa:adjust' },
        { text: '\u23ed\ufe0f Skip', callbackData: 'wa:skip' },
      ],
    ],
  });
}
