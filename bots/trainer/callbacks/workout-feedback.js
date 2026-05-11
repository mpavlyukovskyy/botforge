/**
 * Callback: workout-feedback (prefix: 'wf')
 *
 * Handles post-workout feedback inline keyboard buttons.
 * Multi-step flow:
 *   Step 1: RPE accuracy (easier/as_planned/harder)
 *   Step 2: Energy level (fresh/normal/fatigued/exhausted — only shown after step 1, skipped inline)
 *   Step 3: Joint pain (none/minor/significant)
 *   Step 4 (conditional): Joint pain location (shoulder/knee/back/elbow/wrist)
 *
 * callback_data format: 'wf:STEP:VALUE' or 'wf:STEP:VALUE:EXTRA'
 */
import { ensureDb, getActiveProgram, saveWorkoutFeedback, getFeedbackForDate } from '../lib/db.js';

export default {
  prefix: 'wf',
  async execute(data, ctx) {
    const parts = data.split(':');
    const step = parts[1];
    const value = parts[2];
    const chatId = ctx.chatId;

    if (!step || !value) {
      await ctx.answerCallback('Error: invalid data');
      return;
    }

    try {
      ensureDb(ctx.config);
    } catch {
      await ctx.answerCallback('DB error');
      return;
    }

    // Guard: no active program → no-op
    const program = getActiveProgram(ctx.config);
    if (!program) {
      await ctx.answerCallback('No active program');
      return;
    }

    // ── Step 1: RPE accuracy ───────────────────────────────────────────────
    if (step === 'rpe') {
      // Store in transient state, move to next question
      ctx.store.set('feedback_rpe', value);
      await ctx.answerCallback('Got it');

      await ctx.adapter.send({
        chatId,
        text: 'Energy level after the session?',
        inlineKeyboard: [[
          { text: 'Fresh', callbackData: 'wf:energy:fresh' },
          { text: 'Normal', callbackData: 'wf:energy:normal' },
        ], [
          { text: 'Fatigued', callbackData: 'wf:energy:fatigued' },
          { text: 'Exhausted', callbackData: 'wf:energy:exhausted' },
        ]],
      });
      return;
    }

    // ── Step 2: Energy / fatigue level ─────────────────────────────────────
    if (step === 'energy') {
      ctx.store.set('feedback_energy', value);
      await ctx.answerCallback('Got it');

      await ctx.adapter.send({
        chatId,
        text: 'Any joint pain?',
        inlineKeyboard: [[
          { text: 'None', callbackData: 'wf:pain:none' },
          { text: 'Minor', callbackData: 'wf:pain:minor' },
          { text: 'Significant', callbackData: 'wf:pain:significant' },
        ]],
      });
      return;
    }

    // ── Step 3: Joint pain ─────────────────────────────────────────────────
    if (step === 'pain') {
      ctx.store.set('feedback_pain', value);

      if (value === 'minor' || value === 'significant') {
        await ctx.answerCallback('Got it');
        await ctx.adapter.send({
          chatId,
          text: 'Where?',
          inlineKeyboard: [[
            { text: 'Shoulder', callbackData: 'wf:location:shoulder' },
            { text: 'Knee', callbackData: 'wf:location:knee' },
            { text: 'Back', callbackData: 'wf:location:back' },
          ], [
            { text: 'Elbow', callbackData: 'wf:location:elbow' },
            { text: 'Wrist', callbackData: 'wf:location:wrist' },
            { text: 'Hip', callbackData: 'wf:location:hip' },
          ]],
        });
        return;
      }

      // No pain → save immediately
      await saveFeedback(ctx, chatId, null);
      return;
    }

    // ── Step 4: Joint pain location ────────────────────────────────────────
    if (step === 'location') {
      await saveFeedback(ctx, chatId, value);
      return;
    }

    await ctx.answerCallback('Unknown step');
  },
};

/**
 * Collect all stored feedback and persist to DB.
 */
async function saveFeedback(ctx, chatId, painLocation) {
  const rpe = ctx.store.get('feedback_rpe') || 'as_prescribed';
  const energy = ctx.store.get('feedback_energy') || 'normal';
  const pain = ctx.store.get('feedback_pain') || 'none';

  const workoutDate = ctx.store.get('feedback_workout_date')
    || new Date().toISOString().slice(0, 10);

  // Get session title from last pending workout or fallback
  const sessionTitle = ctx.store.get('last_session_title') || null;

  try {
    saveWorkoutFeedback(ctx.config, {
      workout_date: workoutDate,
      session_title: sessionTitle,
      fatigue_level: energy,
      rpe_accuracy: rpe,
      joint_pain: pain,
      joint_pain_location: painLocation,
    });
  } catch (err) {
    ctx.log?.warn?.(`Failed to save feedback: ${err.message}`);
  }

  // Clear transient state
  ctx.store.set('feedback_rpe', null);
  ctx.store.set('feedback_energy', null);
  ctx.store.set('feedback_pain', null);
  ctx.store.set('feedback_workout_date', null);

  await ctx.answerCallback('Feedback saved');

  // Build confirmation echo
  const rpeLabels = {
    easier_than_prescribed: 'Easier than planned',
    as_prescribed: 'As planned',
    harder_than_prescribed: 'Harder than planned',
  };
  const rpeLabel = rpeLabels[rpe] || rpe;
  const painLabel = pain === 'none'
    ? 'No pain'
    : `${pain.charAt(0).toUpperCase() + pain.slice(1)} pain${painLocation ? ` (${painLocation})` : ''}`;

  await ctx.adapter.send({
    chatId,
    text: [
      `Logged for ${sessionTitle || workoutDate}:`,
      `Effort: ${rpeLabel}`,
      `Energy: ${energy.charAt(0).toUpperCase() + energy.slice(1)}`,
      `Pain: ${painLabel}`,
      '',
      "I'll factor this into your next session.",
    ].join('\n'),
  });
}

/**
 * Send feedback prompt to user after a completed workout.
 * Called from daily-sync or after workout approval.
 *
 * @param {object} ctx - Bot context
 * @param {string} chatId - Chat ID
 * @param {string} [sessionTitle] - Optional session title
 * @param {string} [workoutDate] - Date of the workout (YYYY-MM-DD), defaults to today
 */
export async function sendFeedbackPrompt(ctx, chatId, sessionTitle, workoutDate) {
  const program = getActiveProgram(ctx.config);
  if (!program) return;

  const date = workoutDate || new Date().toISOString().slice(0, 10);
  if (sessionTitle) {
    ctx.store.set('last_session_title', sessionTitle);
  }
  ctx.store.set('feedback_workout_date', date);

  // Add day name when prompting about a past workout (e.g., daily-sync asking about yesterday)
  const promptToday = new Date().toISOString().slice(0, 10);
  let titlePart = '';
  if (sessionTitle && date !== promptToday) {
    const dayLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    titlePart = ` (${sessionTitle} — ${dayLabel})`;
  } else if (sessionTitle) {
    titlePart = ` (${sessionTitle})`;
  } else if (date !== promptToday) {
    const dayLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    titlePart = ` (${dayLabel})`;
  }

  await ctx.adapter.send({
    chatId,
    text: `How'd that session feel?${titlePart}\n\nEffort vs plan:`,
    inlineKeyboard: [[
      { text: 'Easier', callbackData: 'wf:rpe:easier_than_prescribed' },
      { text: 'As planned', callbackData: 'wf:rpe:as_prescribed' },
      { text: 'Harder', callbackData: 'wf:rpe:harder_than_prescribed' },
    ]],
  });
}
