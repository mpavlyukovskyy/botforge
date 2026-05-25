/**
 * Callback: workout-approval (prefix: 'wa')
 *
 * Handles inline keyboard actions for morning workout cards.
 * callback_data format: 'wa:ACTION' or 'wa:ACTION:ID'
 * Actions: approve, adjust, skip
 *
 * Hardened 2026-05-21:
 *   - In-flight guard (prevents racing taps)
 *   - Routine reuse via hevy_routine_ids mapping (UPDATE not CREATE)
 *   - Stale-button friendly message
 *   - Edit the source workout card after successful push so stale taps
 *     can't re-fire the callback
 */
import { ensureDb, createCheckIn, getPendingWorkout, markPendingWorkoutPushed, getAllExerciseTemplates, getState, setState } from '../lib/db.js';
import { createRoutine, updateRoutine } from '../lib/hevy-client.js';
import { markApprovedExerciseUsed } from '../lib/exercise-library.js';
// workout-feedback removed 2026-05-23 — Mark explicitly doesn't want post-workout prompts.

const HEVY_ROUTINE_IDS_KEY = 'hevy_routine_ids';

function getHevyRoutineMap(config) {
  try {
    const raw = getState(config, HEVY_ROUTINE_IDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function setHevyRoutineMap(config, map) {
  setState(config, HEVY_ROUTINE_IDS_KEY, JSON.stringify(map));
}

export default {
  prefix: 'wa',
  async execute(data, ctx) {
    const parts = data.split(':');
    const action = parts[1];

    if (!action) {
      await ctx.answerCallback('Error: invalid data');
      return;
    }

    const chatId = ctx.chatId;

    if (action === 'approve') {
      const pendingId = parts[2] ? parseInt(parts[2], 10) : null;

      if (!pendingId) {
        await ctx.adapter.send({ chatId, text: '✅ Workout approved — get after it!' });
        await ctx.answerCallback('Approved!');
        return;
      }

      // In-flight guard prevents racing taps
      const inFlightKey = `approving:${pendingId}`;
      if (ctx.store.get(inFlightKey)) {
        ctx.log?.warn?.(`wa:approve:${pendingId} already in flight, skipping`);
        await ctx.answerCallback('Already sending...');
        return;
      }
      ctx.store.set(inFlightKey, true);

      await ctx.answerCallback('Creating in Hevy...');

      try {
        ensureDb(ctx.config);
        const pending = getPendingWorkout(ctx.config, pendingId);
        if (!pending) {
          ctx.log?.warn?.(`Pending workout ${pendingId} not found`);
          await ctx.adapter.send({
            chatId,
            text: 'This workout card is from an earlier session — send /workout to get today\'s.',
          });
          return;
        }

        if (pending.pushed_at) {
          ctx.log?.info?.(`Re-tap on pending workout ${pendingId}: already pushed at ${pending.pushed_at}`);
          await ctx.adapter.send({
            chatId,
            text: `Already sent to Hevy — look for "${pending.title || 'your workout'}" in your Routines tab.`,
          });
          return;
        }

        const exercises = JSON.parse(pending.exercises_json);
        const templates = getAllExerciseTemplates(ctx.config);

        if (templates.length === 0) {
          await ctx.adapter.send({ chatId, text: '⚠️ No exercise templates cached — run /sync first, then tap Start in Hevy again.' });
          return;
        }

        const titleMap = new Map(templates.map((t) => [t.title.toLowerCase(), t]));
        const resolved = [];
        const unresolved = [];
        let fuse = null;

        for (const ex of exercises) {
          let template = titleMap.get(ex.name.toLowerCase());
          if (!template) {
            if (!fuse) {
              const { default: Fuse } = await import('fuse.js');
              fuse = new Fuse(templates, { keys: ['title'], threshold: 0.4, includeScore: true });
            }
            const results = fuse.search(ex.name, { limit: 1 });
            if (results.length > 0 && results[0].score <= 0.4) {
              template = results[0].item;
              ctx.log?.info?.(`Fuzzy matched "${ex.name}" -> "${template.title}" (score: ${results[0].score.toFixed(3)})`);
            }
          }
          if (!template) {
            unresolved.push(ex.name);
            continue;
          }
          resolved.push({
            exercise_template_id: template.id,
            sets: Array.from({ length: ex.sets || 3 }, () => ({
              type: 'normal',
              weight_kg: Math.round((ex.weight_kg || 0) * 2) / 2,
              reps: ex.reps || 8,
            })),
          });
        }

        if (resolved.length === 0) {
          await ctx.adapter.send({
            chatId,
            text: `⚠️ Could not match exercises to Hevy library: ${unresolved.join(', ')}\n\nRun /sync to update templates, then tap Start in Hevy again.`,
          });
          return;
        }

        // ──────────────────────────────────────────────────────────────────
        // Routine reuse: look up existing Hevy routine for this session label.
        // Update in place if found; otherwise create + persist the new ID.
        // ──────────────────────────────────────────────────────────────────
        const sessionLabel = pending.title || 'Workout';
        const routineMap = getHevyRoutineMap(ctx.config);
        const existingRoutineId = routineMap[sessionLabel];

        const notes = `${pending.time_minutes || 60} min — generated by Trainer`;
        let hevyId;
        let wasUpdate = false;

        if (existingRoutineId) {
          try {
            const result = await updateRoutine(existingRoutineId, {
              title: sessionLabel,
              notes,
              exercises: resolved,
            });
            hevyId = result?.id || result?.routine?.id || existingRoutineId;
            wasUpdate = true;
            ctx.log?.info?.(`Hevy routine updated: "${sessionLabel}" (ID: ${hevyId}, exercises: ${resolved.length})`);
          } catch (err) {
            // Fall through to create — routine may have been deleted in Hevy
            ctx.log?.warn?.(`updateRoutine failed for ${existingRoutineId}; will create fresh: ${err.message}`);
            delete routineMap[sessionLabel];
          }
        }

        if (!wasUpdate) {
          const result = await createRoutine({
            title: sessionLabel,
            notes,
            exercises: resolved,
          });
          hevyId = result?.id || result?.routine?.id;
          if (hevyId) {
            routineMap[sessionLabel] = hevyId;
            setHevyRoutineMap(ctx.config, routineMap);
          }
          ctx.log?.info?.(`Hevy routine created: "${sessionLabel}" (ID: ${hevyId || 'unknown'}, exercises: ${resolved.length})`);
        }

        // Stamp `used_at` on any approved-novel exercises that just got pushed.
        // (`approved_exercises` TTL pruning won't drop these anymore.)
        if (hevyId) {
          for (const ex of resolved) {
            const tplId = ex?.exercise_template_id || ex?.template_id;
            if (tplId) {
              try { markApprovedExerciseUsed(ctx.config, tplId); }
              catch (e) { ctx.log?.debug?.(`markApprovedExerciseUsed(${tplId}) failed: ${e.message}`); }
            }
          }
        }

        const verb = wasUpdate ? 'updated' : 'created';
        let msg = `✅ Routine ${verb} in Hevy — ${resolved.length} exercises.\n📋 "${sessionLabel}"\nOpen Hevy → Routines → tap Start!`;
        if (unresolved.length > 0) {
          msg += `\n\n_(Could not match: ${unresolved.join(', ')} — add manually)_`;
        }
        await ctx.adapter.send({ chatId, text: msg });

        try {
          markPendingWorkoutPushed(ctx.config, pendingId, sessionLabel);
        } catch (e) {
          ctx.log?.warn?.(`Failed to mark workout ${pendingId} as pushed: ${e.message}`);
        }

        // Strip the inline buttons from the original card so stale taps can't re-fire.
        // Best-effort; ignore if edit isn't supported or message can't be edited.
        if (ctx.adapter.edit && ctx.messageId) {
          try {
            await ctx.adapter.edit(ctx.messageId, chatId, {
              text: `✅ Sent to Hevy: "${sessionLabel}"`,
            });
          } catch (e) {
            ctx.log?.debug?.(`Edit original card failed (non-fatal): ${e.message}`);
          }
        }

        // (Post-workout feedback prompt removed 2026-05-23.)
      } catch (err) {
        ctx.log?.warn?.(`Hevy push failed: ${err.message}`);
        await ctx.adapter.send({
          chatId,
          text: `Hevy push failed: ${err.message}\n\nYour prescription is saved — try /workout again or log manually.`,
        });
      } finally {
        ctx.store.set(inFlightKey, false);
      }
      return;
    }

    if (action === 'adjust') {
      await ctx.adapter.send({
        chatId,
        text: "What would you like to change? (e.g. swap an exercise, reduce volume, change weight targets)",
      });
      ctx.store.set('mode', 'workout-adjust');
      await ctx.answerCallback('Tell me what to change');
      return;
    }

    if (action === 'skip') {
      try {
        ensureDb(ctx.config);
        const date = new Date().toISOString().slice(0, 10);
        createCheckIn(ctx.config, 'skip', `Skipped workout on ${date}: user choice`, { date });
      } catch {}

      if (ctx.adapter.edit) {
        try {
          await ctx.adapter.edit(ctx.messageId, chatId, {
            text: '⏭️ Workout skipped — rest day logged.',
          });
        } catch {}
      }
      await ctx.answerCallback('Rest day logged');
      return;
    }

    await ctx.answerCallback('Unknown action');
  },
};
