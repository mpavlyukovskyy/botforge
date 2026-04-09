/**
 * Command: /status
 *
 * Quick status: recovery + program week + next workout.
 */
import { ensureDb, getActiveProgram, getRecoveryForDate } from '../lib/db.js';

export default {
  command: 'status',
  description: 'Quick status — recovery, program week, next workout',
  async execute(args, ctx) {
    const chatId = ctx.chatId;

    try {
      ensureDb(ctx.config);
    } catch {
      await ctx.adapter.send({ chatId, text: 'Database not available.' });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    const lines = [];
    lines.push(`*Status — ${dayName}, ${today}*`);
    lines.push('');

    // Recovery
    const recovery = getRecoveryForDate(ctx.config, today);
    if (recovery) {
      const readiness = recovery.combined_readiness || 'unknown';
      const emoji = readiness === 'green' ? '\u2705' : readiness === 'yellow' ? '\u26a0\ufe0f' : readiness === 'red' ? '\ud83d\uded1' : '\u2753';
      lines.push(`Recovery: ${emoji} ${readiness.toUpperCase()}`);
      if (recovery.whoop_recovery_score != null) {
        lines.push(`  Whoop: ${recovery.whoop_recovery_score}% recovery, HRV ${Math.round(recovery.whoop_hrv || 0)}ms`);
      }
      if (recovery.eightsleep_sleep_score != null) {
        lines.push(`  Eight Sleep: ${recovery.eightsleep_sleep_score} sleep score`);
      }
    } else {
      lines.push('Recovery: no data yet (syncs at 5am)');
    }

    lines.push('');

    // Program
    const program = getActiveProgram(ctx.config);
    if (program) {
      let programData;
      try {
        programData = JSON.parse(program.program_json);
      } catch {
        programData = {};
      }

      lines.push(`Program: ${program.title}`);
      lines.push(`Week ${program.current_week} of ${program.total_weeks}`);

      // Today's session
      const template = programData.weekly_template || {};
      const todaySession = template[dayName];
      if (todaySession) {
        lines.push(`Today: ${todaySession.name} (${todaySession.exercises?.length || 0} exercises)`);
      } else {
        lines.push('Today: Rest day');
      }
    } else {
      lines.push('Program: none — use /goals then /program new');
    }

    await ctx.adapter.send({
      chatId,
      text: lines.join('\n'),
      parseMode: 'Markdown',
    });
  },
};
