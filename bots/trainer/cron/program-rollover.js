/**
 * Cron: program_rollover
 *
 * Fires daily at 06:55am ET — just before morning_workout. Two jobs:
 *
 *   1. Advance the active program's current_week each Sunday.
 *   2. If current_week > total_weeks → call designProgram() to build a new
 *      block constrained to Mark's USED exercises + RELEVANT_HEVY.
 *
 *      Outcomes:
 *        - status:'active'  → all-USED design. Persist immediately:
 *            • complete old program
 *            • createProgram() with new JSON
 *            • clear hevy_routine_ids
 *            • notify "New block: <name>"
 *        - status:'pending' → contains novels. DO NOT complete the old program
 *            and DO NOT clear routine IDs. Send a 2-message approval card:
 *            • msg 1: block summary + numbered novel list + usage hint
 *            • msg 2: full weekly_template render
 *          Mark must reply with /approve <numbers> or /cancel before the new
 *          program is activated. The morning_workout cron at 07:00am keeps
 *          using the old active program meanwhile.
 *
 * Cron does NOT touch chat_lock; that's per-message-handler. Race safety with
 * /approve is handled by db.transaction wrapping pending_program writes.
 */
import {
  ensureDb,
  getActiveProgram,
  getCachedWorkouts,
  getRecentProgramHistory,
  advanceProgramWeek,
  completeProgramById,
  createProgram,
  setState,
} from '../lib/db.js';
import { designProgram, ERROR_CLASSES } from '../lib/program-designer.js';
import { notifyCapHit } from '../lib/claude.js';

const DEFAULT_GOALS = [
  'Build muscle mass (hypertrophy-focused training)',
  'Train consistently 4x per week',
];

const TG_MARKDOWN_LIMIT = 4096;
const TG_SAFE_LIMIT = 3800;

function buildRotationContext(history) {
  if (!history?.length) return '';
  const lines = history.map((h) => {
    let line = `- ${h.exercise_title}: ${h.final_status || 'unknown'}`;
    if (h.final_weight_kg) line += ` @ ${h.final_weight_kg}kg`;
    if (h.final_status === 'stalled') line += ' — consider variant';
    return line;
  });
  return `\nPREVIOUS PROGRAM EXERCISES:\n${lines.join('\n')}\n\nFor stalled exercises, substitute with a biomechanically similar variant. For progressing exercises, keep them.`;
}

/**
 * Build msg 1: block summary + numbered novel list with usage hint.
 * Novels are numbered globally across all days (R3 final plan).
 */
function buildApprovalMessage1(program, novelList) {
  const lines = [];
  lines.push(`*New program proposed: ${program.block_name}*`);
  lines.push(`${program.duration_weeks} weeks, ${program.days_per_week}× per week, ${program.split} split`);
  lines.push('');
  if (novelList.length === 0) {
    lines.push('All exercises are from your USED history. Reply `/approve all` or `/cancel`.');
    return lines.join('\n');
  }
  lines.push(`I want to introduce ${novelList.length} new exercise${novelList.length > 1 ? 's' : ''} (you haven't done these yet):`);
  lines.push('');
  novelList.forEach((n, i) => {
    const num = i + 1;
    const mg = n.muscle_group ? ` _(${n.muscle_group})_` : '';
    lines.push(`${num}. *${n.name}*${mg} — ${n.day}`);
  });
  lines.push('');
  lines.push('Reply with the numbers you approve, e.g. `/approve 1, 3` or `/approve all` or `/approve none`.');
  lines.push('Unapproved exercises will be substituted (same muscle, your most-used) or dropped.');
  lines.push('Or `/cancel` to discard this design.');
  return lines.join('\n');
}

/**
 * Build msg 2: full weekly_template render. Falls back to splitting into
 * multiple messages if it would exceed Telegram's 4096-char limit.
 */
function buildWeeklyTemplateMessages(program) {
  const lines = [];
  lines.push('*Full weekly template:*');
  for (const [day, session] of Object.entries(program.weekly_template)) {
    lines.push('');
    lines.push(`*${day} — ${session.name}*`);
    if (session.focus) lines.push(`_${session.focus}_`);
    for (const ex of session.exercises || []) {
      const parts = [`• ${ex.name}`];
      if (ex.sets) parts.push(`${ex.sets}×${ex.rep_range || '?'}`);
      if (ex.rpe_target) parts.push(`@RPE ${ex.rpe_target}`);
      lines.push(parts.join(' '));
    }
  }
  const full = lines.join('\n');
  if (full.length <= TG_SAFE_LIMIT) return [full];

  // Split per day if too long
  const chunks = [];
  let buf = ['*Full weekly template:*'];
  for (const [day, session] of Object.entries(program.weekly_template)) {
    const dayLines = ['', `*${day} — ${session.name}*`];
    if (session.focus) dayLines.push(`_${session.focus}_`);
    for (const ex of session.exercises || []) {
      const parts = [`• ${ex.name}`];
      if (ex.sets) parts.push(`${ex.sets}×${ex.rep_range || '?'}`);
      if (ex.rpe_target) parts.push(`@RPE ${ex.rpe_target}`);
      dayLines.push(parts.join(' '));
    }
    const candidate = buf.join('\n') + '\n' + dayLines.join('\n');
    if (candidate.length > TG_SAFE_LIMIT) {
      chunks.push(buf.join('\n'));
      buf = dayLines;
    } else {
      buf = buf.concat(dayLines);
    }
  }
  if (buf.length > 0) chunks.push(buf.join('\n'));
  return chunks;
}

async function sendApprovalCard(ctx, chatId, program, novelList) {
  try {
    await ctx.adapter.send({
      chatId,
      text: buildApprovalMessage1(program, novelList),
      parseMode: 'Markdown',
    });
  } catch (err) {
    ctx.log?.warn?.(`approval msg1 send failed: ${err.message}`);
  }
  for (const chunk of buildWeeklyTemplateMessages(program)) {
    try {
      await ctx.adapter.send({ chatId, text: chunk, parseMode: 'Markdown' });
    } catch (err) {
      ctx.log?.warn?.(`approval msg2 chunk send failed: ${err.message}`);
    }
  }
}

export default {
  name: 'program_rollover',
  async execute(ctx) {
    ensureDb(ctx.config);
    const chatId = ctx.store?.get('chat_id')
      || ctx.config.platform?.chat_ids?.[0]
      || process.env.TRAINER_CHAT_ID;

    const program = getActiveProgram(ctx.config);

    // 1. Weekly advance — only on Sunday morning, only if active program exists
    const dayName = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'America/New_York',
    });
    if (program && dayName === 'Sunday') {
      try {
        advanceProgramWeek(ctx.config, program.id);
        ctx.log?.info?.(`Advanced program ${program.id} to week ${program.current_week + 1}`);
      } catch (err) {
        ctx.log?.warn?.(`advanceProgramWeek failed: ${err.message}`);
      }
    }

    // 2. Block rollover — only when block is past its total_weeks (OR no program at all)
    const fresh = getActiveProgram(ctx.config);
    const needsRollover = !fresh || (fresh.current_week > fresh.total_weeks);
    if (!needsRollover) return;

    ctx.log?.info?.('program_rollover: designing new block');

    // Build context for the designer
    const today = new Date().toISOString().slice(0, 10);
    const history = getRecentProgramHistory(ctx.config, 2);

    // Inherit goals snapshot from previous program OR use defaults
    let goalsSnapshot = DEFAULT_GOALS;
    if (fresh?.goals_snapshot) {
      try {
        const parsed = JSON.parse(fresh.goals_snapshot);
        if (Array.isArray(parsed) && parsed.length > 0) goalsSnapshot = parsed;
      } catch { /* keep default */ }
    }

    const result = await designProgram({
      config: ctx.config,
      goalsSnapshot,
      rotationContext: buildRotationContext(history),
      log: ctx.log,
    });

    // Idempotency: existing pending <24h
    if (!result.ok && result.status === 'pending') {
      ctx.log?.info?.('program_rollover: pending program from earlier still awaiting approval — re-sending card');
      if (chatId) {
        await sendApprovalCard(ctx, chatId, result.pending.program, result.pending.novelList || []);
      }
      return;
    }

    // Hard error (Opus / parse / shape)
    if (!result.ok) {
      ctx.log?.error?.(`program_rollover: design failed (${result.error_class || '?'}): ${result.reason}`);
      if (result.error_class === ERROR_CLASSES.CAP_HIT && chatId) {
        await notifyCapHit(ctx, chatId, result.reason);
      }
      return;
    }

    // status === 'pending' — novel-approval flow
    if (result.status === 'pending') {
      ctx.log?.info?.(`program_rollover: ${result.novelList.length} novel exercise(s) need approval — old program kept active`);
      if (chatId) {
        await sendApprovalCard(ctx, chatId, result.program, result.novelList);
      }
      return;
    }

    // status === 'active' — all-USED design, persist directly
    if (fresh) {
      try {
        completeProgramById(ctx.config, fresh.id);
      } catch (err) {
        ctx.log?.warn?.(`completeProgramById failed: ${err.message}`);
      }
    }

    const programData = result.program;
    const title = programData.block_name;
    const validFrom = today;
    try {
      createProgram(
        ctx.config,
        title,
        JSON.stringify(programData),
        JSON.stringify(goalsSnapshot),
        programData.duration_weeks,
        validFrom,
      );
      ctx.log?.info?.(`program_rollover: created "${title}" (${programData.duration_weeks} weeks)`);
    } catch (err) {
      ctx.log?.error?.(`program_rollover: persist failed: ${err.message}`);
      return;
    }

    // Clear the Hevy routine ID mapping — new block starts with fresh routines.
    try {
      setState(ctx.config, 'hevy_routine_ids', '{}');
    } catch (err) {
      ctx.log?.warn?.(`clear hevy_routine_ids failed: ${err.message}`);
    }

    // Notify Mark (one line)
    if (chatId) {
      const droppedNote = (result.droppedList?.length || 0) > 0
        ? `\n_Note: ${result.droppedList.length} exercise(s) dropped (no Hevy match)._`
        : '';
      try {
        await ctx.adapter.send({
          chatId,
          text: `Last block completed. New ${programData.duration_weeks}-week block starts today: *${title}*.${droppedNote}`,
          parseMode: 'Markdown',
        });
      } catch (err) {
        ctx.log?.warn?.(`rollover notify failed: ${err.message}`);
      }
    }
  },
};

// Exports for testing
export { buildApprovalMessage1, buildWeeklyTemplateMessages, sendApprovalCard };
