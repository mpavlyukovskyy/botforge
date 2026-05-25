/**
 * Command: /redesign
 *
 * Force-discards any pending program and immediately re-triggers designProgram.
 * Useful when /approve substitutions leave a day too sparse, or when Mark just
 * wants a fresh attempt without waiting for the 6:55am cron.
 */
import { ensureDb, getActiveProgram, getRecentProgramHistory } from '../lib/db.js';
import { clearPendingProgram } from '../lib/exercise-library.js';
import { designProgram, ERROR_CLASSES } from '../lib/program-designer.js';
import { notifyCapHit } from '../lib/claude.js';

const DEFAULT_GOALS = [
  'Build muscle mass (hypertrophy-focused training)',
  'Train consistently 4x per week',
];

function buildRotationContext(history) {
  if (!history?.length) return '';
  const lines = history.map((h) => {
    let line = `- ${h.exercise_title}: ${h.final_status || 'unknown'}`;
    if (h.final_weight_kg) line += ` @ ${h.final_weight_kg}kg`;
    if (h.final_status === 'stalled') line += ' — consider variant';
    return line;
  });
  return `\nPREVIOUS PROGRAM EXERCISES:\n${lines.join('\n')}\n\nFor stalled exercises, substitute with a biomechanically similar variant.`;
}

export default {
  command: 'redesign',
  description: 'Discard any pending program and design a fresh one now',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    ensureDb(ctx.config);

    // Wipe pending so designProgram doesn't short-circuit on idempotency
    clearPendingProgram(ctx.config);

    const active = getActiveProgram(ctx.config);
    let goalsSnapshot = DEFAULT_GOALS;
    if (active?.goals_snapshot) {
      try {
        const parsed = JSON.parse(active.goals_snapshot);
        if (Array.isArray(parsed) && parsed.length > 0) goalsSnapshot = parsed;
      } catch { /* default */ }
    }
    const history = getRecentProgramHistory(ctx.config, 2);

    await ctx.adapter.send({ chatId, text: 'Designing a fresh program — this takes 30-60 seconds…' });

    const result = await designProgram({
      config: ctx.config,
      goalsSnapshot,
      rotationContext: buildRotationContext(history),
      log: ctx.log,
    });

    if (!result.ok) {
      if (result.error_class === ERROR_CLASSES.CAP_HIT) {
        await notifyCapHit(ctx, chatId, result.reason);
        return;
      }
      await ctx.adapter.send({ chatId, text: `Redesign failed: ${result.reason}` });
      return;
    }

    // Delegate the rest of the notification to program-rollover's logic by
    // sending the approval card OR confirming activation.
    // For simplicity, we just tell the user what status and let cron handle
    // the full notification on next tick — OR fire it now.
    // Inlining the send-card behavior to keep redesign self-contained:
    if (result.status === 'pending') {
      const { sendApprovalCard } = await import('../cron/program-rollover.js');
      await sendApprovalCard(ctx, chatId, result.program, result.novelList);
    } else {
      // status: 'active' — activate immediately (same path as cron's active branch)
      const { default: rollover } = await import('../cron/program-rollover.js');
      // We can't easily re-call rollover.execute here without duplicating its
      // "designProgram" call. So just tell the user, let next cron persist.
      await ctx.adapter.send({
        chatId,
        text: `New program design ready (no novels): *${result.program.block_name}* (${result.program.duration_weeks} weeks). ` +
          'It will activate at the next program_rollover (6:55am ET) — or run `/workout` and tomorrow\'s cron will pick it up.',
        parseMode: 'Markdown',
      });
      // Actually — to give an immediate result, write it as pending with empty novelList
      // so /approve all activates it
      const { setPendingProgram } = await import('../lib/exercise-library.js');
      setPendingProgram(ctx.config, {
        program: result.program,
        novelList: [],
        droppedList: result.droppedList || [],
        createdAt: Date.now(),
        designedAgainstWorkoutCountAtTime: null,
      });
      await ctx.adapter.send({
        chatId,
        text: 'Reply `/approve all` to activate now, or `/cancel` to discard.',
        parseMode: 'Markdown',
      });
    }
  },
};
