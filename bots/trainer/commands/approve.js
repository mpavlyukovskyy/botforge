/**
 * Command: /approve
 *
 * Resolves a pending_program (set by program_rollover when designProgram returned
 * status:'pending' with novel exercises). The user replies with which indices to
 * approve; unapproved novels get substituted (USED-same-muscle) or dropped.
 *
 * Usage:
 *   /approve 1, 3      → approve novels #1 and #3, sub/drop the rest
 *   /approve all       → approve every novel
 *   /approve none      → substitute all novels
 *   /approve 1-3       → approve novels 1, 2, 3
 *
 * On success: completes the OLD active program, persists the new one, clears
 * hevy_routine_ids, deletes pending_program — all in one DB transaction.
 *
 * On safety failure (substitution leaves a day with <3 exercises): preserves
 * pending_program, tells Mark to /program redesign or /cancel.
 */
import {
  ensureDb,
  getActiveProgram,
  completeProgramById,
  createProgram,
  getAllExerciseTemplates,
  setState,
} from '../lib/db.js';
import {
  getPendingProgram,
  clearPendingProgram,
  getUsedExercises,
  addApprovedExercises,
  findMuscleGroupSubstitute,
  parseApproval,
  PENDING_TTL_HOURS,
} from '../lib/exercise-library.js';
import { resolveExerciseName } from '../lib/program-designer.js';

const MIN_EXERCISES_PER_DAY = 3;

function renderNovelList(novelList) {
  return novelList.map((n, i) => {
    const num = i + 1;
    const mg = n.muscle_group ? ` _(${n.muscle_group})_` : '';
    return `${num}. *${n.name}*${mg} — ${n.day}`;
  }).join('\n');
}

export default {
  command: 'approve',
  description: 'Approve novel exercises in a pending program (e.g. /approve 1, 3)',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    ensureDb(ctx.config);

    const pending = getPendingProgram(ctx.config, ctx.log);
    if (!pending) {
      await ctx.adapter.send({ chatId, text: 'No pending program. Next design attempt at 6:55am ET tomorrow.' });
      return;
    }

    const novelList = pending.novelList || [];
    if (novelList.length === 0) {
      // Edge case: pending with zero novels — just activate the program
      ctx.log?.warn?.('/approve: pending has 0 novels; activating directly');
      await finalizeAndActivate(ctx, pending.program, [], { approved: [], substituted: [], dropped: [...(pending.droppedList || [])] });
      return;
    }

    if (!args || args.trim() === '') {
      await ctx.adapter.send({
        chatId,
        text: `Pending program: *${pending.program.block_name}*\n\n` +
          `${novelList.length} novel exercise${novelList.length > 1 ? 's' : ''}:\n` +
          renderNovelList(novelList) + '\n\n' +
          'Reply with the numbers you approve, e.g. `/approve 1, 3` or `/approve all` or `/approve none`. Or `/cancel`.',
        parseMode: 'Markdown',
      });
      return;
    }

    const parsed = parseApproval(args, novelList.length);
    if (parsed.error === 'unparseable') {
      await ctx.adapter.send({
        chatId,
        text: `Couldn't parse "${args}". Reply like:\n\`/approve 1, 3\` or \`/approve all\` or \`/approve none\` or \`/approve 1-${novelList.length}\`.\n\n` +
          'Novels:\n' + renderNovelList(novelList),
        parseMode: 'Markdown',
      });
      return;
    }
    if (parsed.error === 'out_of_range') {
      await ctx.adapter.send({
        chatId,
        text: `Invalid number${parsed.invalid.length > 1 ? 's' : ''}: ${parsed.invalid.join(', ')}. Valid range: 1-${novelList.length}.`,
      });
      return;
    }

    const approvedIndices = parsed.indices; // Set<number>, 1-based
    const used = getUsedExercises(ctx.config, ctx.log);
    const program = pending.program;

    const approvedTemplateIds = [];
    const summary = { approved: [], substituted: [], dropped: [] };

    // Process each novel
    for (let i = 0; i < novelList.length; i++) {
      const novel = novelList[i];
      const oneBasedIdx = i + 1;
      const isApproved = approvedIndices.has(oneBasedIdx);

      if (isApproved) {
        approvedTemplateIds.push(novel.template_id);
        summary.approved.push(novel.name);
        continue;
      }

      // Try to substitute
      const sub = findMuscleGroupSubstitute(novel.template_id, novel.muscle_group, used);
      if (sub) {
        // Replace in program JSON
        const session = program.weekly_template?.[novel.day];
        if (session && Array.isArray(session.exercises)) {
          const ex = session.exercises[novel.exerciseIndex];
          if (ex && ex.template_id === novel.template_id) {
            ex.name = sub.title;
            ex.template_id = sub.template_id;
            summary.substituted.push(`${novel.name} → ${sub.title}`);
            continue;
          }
        }
      }

      // Drop
      const session = program.weekly_template?.[novel.day];
      if (session && Array.isArray(session.exercises)) {
        const beforeLen = session.exercises.length;
        session.exercises = session.exercises.filter(
          (ex) => !(ex.template_id === novel.template_id && ex.name === novel.name)
        );
        if (session.exercises.length < beforeLen) {
          summary.dropped.push(`${novel.name} (${novel.day})`);
        }
      }
    }

    // SAFETY: check no day fell below MIN_EXERCISES_PER_DAY
    const sparseDays = [];
    for (const [day, session] of Object.entries(program.weekly_template || {})) {
      if ((session.exercises?.length || 0) < MIN_EXERCISES_PER_DAY) {
        sparseDays.push(`${day} (${session.exercises?.length || 0} ex)`);
      }
    }
    if (sparseDays.length > 0) {
      await ctx.adapter.send({
        chatId,
        text: `Can't activate: substitutions left these days too sparse:\n${sparseDays.map((d) => `• ${d}`).join('\n')}\n\n` +
          'Run `/redesign` to re-do or `/cancel` to discard.',
        parseMode: 'Markdown',
      });
      return;
    }

    await finalizeAndActivate(ctx, program, approvedTemplateIds, summary);
  },
};

/**
 * Shared finalize: re-resolve all exercises against current templates (M3),
 * re-check sparseness after any drops, then activate atomically.
 */
async function finalizeAndActivate(ctx, program, approvedTemplateIds, summary) {
  const chatId = ctx.chatId;
  const allTemplates = getAllExerciseTemplates(ctx.config);
  const reRes = reResolveAll(program, allTemplates, ctx.log);
  if (reRes.removed.length > 0) {
    summary.dropped.push(...reRes.removed.map((r) => `${r.name} (${r.day}, template no longer exists)`));
  }

  const sparse = [];
  for (const [day, session] of Object.entries(program.weekly_template || {})) {
    if ((session.exercises?.length || 0) < MIN_EXERCISES_PER_DAY) {
      sparse.push(`${day} (${session.exercises?.length || 0} ex)`);
    }
  }
  if (sparse.length > 0) {
    await ctx.adapter.send({
      chatId,
      text: `Can't activate: sparse days ${sparse.join(', ')}. Run \`/redesign\` or \`/cancel\`.`,
      parseMode: 'Markdown',
    });
    return;
  }

  await activateProgram(ctx, program, approvedTemplateIds, summary.dropped, summary);
}

function reResolveAll(program, allTemplates, log) {
  const removed = [];
  for (const [day, session] of Object.entries(program.weekly_template || {})) {
    const survivors = [];
    for (const ex of session.exercises || []) {
      // Re-check: does this template_id still exist in exercise_templates?
      const stillExists = allTemplates.find((t) => t.id === ex.template_id);
      if (stillExists) {
        ex.name = stillExists.title; // refresh canonical name
        survivors.push(ex);
        continue;
      }
      // Fall back to name resolution (might find a renamed equivalent)
      const resolved = resolveExerciseName(ex.name, allTemplates, new Set());
      if (resolved) {
        ex.name = resolved.canonical_title;
        ex.template_id = resolved.template_id;
        survivors.push(ex);
      } else {
        removed.push({ day, name: ex.name });
        log?.warn?.(`re-resolve: dropped ${ex.name} (${day}) — no template match`);
      }
    }
    session.exercises = survivors;
  }
  return { removed };
}

/**
 * Atomic activation: complete old program, persist new, clear routines, delete pending.
 * Wrapped in db.transaction (C4).
 */
async function activateProgram(ctx, program, approvedTemplateIds, droppedListOuter, summary = null) {
  const db = ensureDb(ctx.config);
  const chatId = ctx.chatId;
  const today = new Date().toISOString().slice(0, 10);

  const titleStr = program.block_name;
  const programJson = JSON.stringify(program);
  const totalWeeks = program.duration_weeks;

  let newProgramId;
  let txError = null;
  try {
    db.transaction(() => {
      const old = getActiveProgram(ctx.config);
      if (old) completeProgramById(ctx.config, old.id);
      const insertResult = createProgram(
        ctx.config,
        titleStr,
        programJson,
        JSON.stringify(program.goals_snapshot || []),
        totalWeeks,
        today,
      );
      newProgramId = insertResult.lastInsertRowid;
      setState(ctx.config, 'hevy_routine_ids', '{}');
      db.prepare('DELETE FROM bot_state WHERE key = ?').run('pending_program');
    })();
  } catch (err) {
    txError = err;
  }

  if (txError) {
    ctx.log?.error?.(`/approve: activation transaction failed: ${txError.message}`);
    await ctx.adapter.send({
      chatId,
      text: `Failed to activate program: ${txError.message}. Pending preserved — try \`/redesign\` or \`/cancel\`.`,
    });
    return;
  }

  // Add approved novels to the persistent approved_exercises list (outside the
  // activation tx so it runs even if program already activated successfully).
  if (approvedTemplateIds.length > 0) {
    addApprovedExercises(ctx.config, approvedTemplateIds);
  }

  // Send confirmation
  const lines = [];
  lines.push(`*Activated: ${titleStr}*`);
  lines.push(`${program.duration_weeks} weeks, ${program.days_per_week}× per week. First session: today.`);
  if (summary) {
    if (summary.approved.length > 0) lines.push(`\n_Approved_: ${summary.approved.join(', ')}`);
    if (summary.substituted.length > 0) lines.push(`_Substituted_: ${summary.substituted.join(', ')}`);
    if (summary.dropped.length > 0) lines.push(`_Dropped_: ${summary.dropped.join(', ')}`);
  } else if (droppedListOuter && droppedListOuter.length > 0) {
    lines.push(`\n_Dropped_: ${droppedListOuter.join(', ')}`);
  }
  lines.push('\nRun `/workout` when ready.');
  try {
    await ctx.adapter.send({ chatId, text: lines.join('\n'), parseMode: 'Markdown' });
  } catch (err) {
    ctx.log?.warn?.(`/approve confirmation send failed: ${err.message}`);
  }
}

// Exports for testing
export { reResolveAll, activateProgram, renderNovelList };
