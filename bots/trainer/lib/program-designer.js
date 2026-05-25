/**
 * Program designer — single source of truth for "design a new periodized block".
 *
 * Called by cron/program-rollover.js (and any future /program-redesign command).
 * Constrained to Mark's USED exercises + a focused RELEVANT_HEVY pool; novels
 * are flagged for explicit approval before activation.
 *
 * Returns ONE of:
 *   {ok:false, status:'pending', pending}   — pending_program <24h old; caller resends approval msg
 *   {ok:true,  status:'active',  program}   — all-USED design; caller persists via createProgram
 *   {ok:true,  status:'pending', novelList, droppedList, program}
 *                                            — novels need approval; caller stores pending_program + notifies
 *   {ok:false, error_class?, reason}        — Opus error or parse failure
 *
 * Persistence (createProgram + completeProgramById + clear hevy_routine_ids)
 * is the CALLER's job, not this module's — keeps the side-effect surface tight.
 */
import { callOpus, ERROR_CLASSES } from './claude.js';
import {
  getUsedExercises,
  getApprovedExercises,
  getRelevantHevyTemplates,
  formatExercisePoolsForPrompt,
  buildHistoryAnalysisBlock,
  getPendingProgram,
  setPendingProgram,
} from './exercise-library.js';
import { ensureDb, getAllExerciseTemplates, getCachedWorkouts } from './db.js';

const PROGRAM_SCHEMA_DESCRIPTION = `
You MUST respond with ONLY valid JSON matching this exact schema:
{
  "block_name": "string (required) — e.g. 'Hypertrophy Block 1'",
  "duration_weeks": number (required) — total weeks,
  "days_per_week": number (required),
  "split": "string (required) — e.g. 'Upper/Lower', 'Push/Pull/Legs'",
  "weekly_template": {
    "<DayName>": {
      "name": "string (required) — session label, e.g. 'Upper A'",
      "focus": "string — muscle groups / movement pattern",
      "exercises": [{
        "name": "string (required) — MUST match an exact title from the USED or RELEVANT_HEVY pool below",
        "sets": number (required) — design at MEV (minimum effective volume) for week 1; volume will ramp automatically,
        "rep_range": "string (required) — e.g. '8-10'",
        "rpe_target": number (optional) — 1-10
      }]
    }
  },
  "volume_progression": {
    "strategy": "additive_ramp",
    "sets_added_per_week": 1,
    "deload_week": number — which week is deload (typically week 4 for 6-week blocks),
    "deload_volume_pct": 50,
    "rpe_start": 7,
    "rpe_end": 9
  },
  "progression_notes": "string — how to progress week to week",
  "deload_protocol": "string — when and how to deload"
}

CRITICAL CONSTRAINTS:
- "name" fields in weekly_template[day].exercises MUST exactly match a title from either the USED or RELEVANT_HEVY pool provided below.
- DO NOT invent new exercise names. DO NOT add parenthetical equipment qualifiers unless they're in the pool title.
- Prefer the USED pool (Mark has done these before). Pick from RELEVANT_HEVY only when the USED pool doesn't have a good fit — the user will be asked to approve each RELEVANT_HEVY pick before it's used.
- Keys in weekly_template MUST be day names: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.
- Do NOT include rest days in the template — only training days.
- Design exercises at MEV (minimum effective volume) for week 1 — the system will automatically ramp volume each week.
- Respond with ONLY the JSON, no markdown fences, no explanation.
`;

const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const EQUIPMENT_HINTS = ['dumbbell', 'barbell', 'machine', 'cable', 'smith', 'kettlebell', 'bodyweight', 'band', 'seated', 'standing', 'incline', 'decline', 'flat'];

function stripParens(name) {
  return (name || '').replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
}

function equipmentHintsIn(name) {
  const lower = (name || '').toLowerCase();
  return EQUIPMENT_HINTS.filter((h) => lower.includes(h));
}

/**
 * Resolve a proposed exercise name to a canonical Hevy template.
 *
 * @param {string} proposedName
 * @param {Array<{id, title, muscle_group, equipment}>} templates  — pool of candidates (USED ∪ RELEVANT_HEVY ∪ allHevy fallback)
 * @param {Set<string>} usedTemplateIdSet  — ids in USED ∪ approved (active)
 * @returns {{canonical_title: string, template_id: string, muscle_group: string|null, was_used: boolean} | null}
 */
export function resolveExerciseName(proposedName, templates, usedTemplateIdSet = new Set()) {
  if (!proposedName || !templates?.length) return null;
  const proposedLower = proposedName.toLowerCase();

  const make = (t) => ({
    canonical_title: t.title,
    template_id: t.id,
    muscle_group: t.muscle_group || null,
    was_used: usedTemplateIdSet.has(t.id),
  });

  // Tier 1: exact match
  for (const t of templates) {
    if (t.title.toLowerCase() === proposedLower) return make(t);
  }

  const proposedBase = stripParens(proposedName);
  const proposedHints = equipmentHintsIn(proposedName);

  // Tier 2: equipment-aware base match
  const baseMatches = templates.filter((t) => stripParens(t.title) === proposedBase);
  if (baseMatches.length > 0) {
    if (proposedHints.length > 0) {
      const equipMatch = baseMatches.find((t) => {
        const tHints = equipmentHintsIn(t.title);
        return proposedHints.every((h) => tHints.includes(h));
      });
      if (equipMatch) return make(equipMatch);
    }
    // Tie-break: prefer USED, then shortest title
    const sorted = baseMatches.slice().sort((a, b) => {
      const aUsed = usedTemplateIdSet.has(a.id) ? 0 : 1;
      const bUsed = usedTemplateIdSet.has(b.id) ? 0 : 1;
      if (aUsed !== bUsed) return aUsed - bUsed;
      return a.title.length - b.title.length;
    });
    return make(sorted[0]);
  }

  // Tier 3+: bidirectional includes
  const includesMatches = templates.filter((t) => {
    const tLower = t.title.toLowerCase();
    return tLower.includes(proposedLower) || proposedLower.includes(tLower);
  });
  if (includesMatches.length > 0) {
    return make(includesMatches.sort((a, b) => a.title.length - b.title.length)[0]);
  }

  return null;
}

// ─── designProgram ───────────────────────────────────────────────────────────

const HISTORY_DAYS = 60;

function defaultVolumeProgression(durationWeeks) {
  return {
    strategy: 'additive_ramp',
    sets_added_per_week: 1,
    deload_week: Math.min(4, durationWeeks),
    deload_volume_pct: 50,
    rpe_start: 7,
    rpe_end: 9,
  };
}

function parseOpusJson(text) {
  const cleaned = (text || '')
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function validateProgramShape(data) {
  if (!data.block_name || !data.duration_weeks || !data.weekly_template) {
    return 'Missing required fields (block_name, duration_weeks, weekly_template)';
  }
  for (const day of Object.keys(data.weekly_template)) {
    if (!VALID_DAYS.includes(day)) return `Invalid day name "${day}"`;
  }
  return null;
}

/**
 * @param {object} input
 * @param {object} input.config          — bot config (for DB access)
 * @param {string[]} input.goalsSnapshot — goal strings inherited from prior block
 * @param {string} [input.rotationContext] — optional "previous program / stall" notes
 * @param {object} [input.log]           — optional ctx.log
 */
export async function designProgram(input) {
  const { config, goalsSnapshot, rotationContext = '', log = console } = input;
  if (!config) return { ok: false, reason: 'Missing config' };

  // Step 0 — Idempotency
  const existingPending = getPendingProgram(config, log);
  if (existingPending) {
    log.info?.('designProgram: existing pending_program <24h — short-circuit');
    return { ok: false, status: 'pending', pending: existingPending };
  }

  // Step 1 — Pools
  ensureDb(config);
  const used = getUsedExercises(config, log);
  const approved = getApprovedExercises(config, log);
  const usedTemplateIdSet = new Set([
    ...used.map((u) => u.template_id),
    ...approved,
  ]);
  const relevantHevy = getRelevantHevyTemplates(config, used);

  // Workouts for history block
  const today = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const workouts = getCachedWorkouts(config, startDate, today);
  const historyBlock = buildHistoryAnalysisBlock(workouts);

  // ALL templates (for fuzzy resolution as backstop)
  const allTemplates = getAllExerciseTemplates(config);

  log.info?.(`designProgram: USED=${used.length}, RELEVANT_HEVY=${relevantHevy.length}, allTemplates=${allTemplates.length}`);

  // Step 2 — Prompt
  const poolsBlock = formatExercisePoolsForPrompt(used, relevantHevy);
  const systemPrompt = `You are an expert strength and conditioning coach designing a periodized training program for one client.
${PROGRAM_SCHEMA_DESCRIPTION}`;
  const userPrompt = `Design a training program based on:

GOALS:
${(goalsSnapshot || []).map((g) => `- ${g}`).join('\n') || '- General hypertrophy'}

RECENT TRAINING HISTORY (last ${HISTORY_DAYS} days):
${historyBlock || '(none cached)'}
${rotationContext}

EXERCISE POOLS (you must pick from these):
${poolsBlock}

Design a periodized program using the pools above. Prefer USED exercises (Mark has done them); pick from RELEVANT_HEVY only when needed — Mark will be asked to approve each RELEVANT_HEVY pick before it's used. Design at MEV for week 1 — the system ramps volume.`;

  // Step 3 — Call Opus (with one parse-retry)
  const callOpts = { timeoutMs: 180_000 };
  let result = await callOpus(systemPrompt, userPrompt, callOpts);
  if (result.is_error) {
    return { ok: false, error_class: result.error_class, reason: result.text };
  }

  let programData;
  try {
    programData = parseOpusJson(result.text);
  } catch {
    // Retry once with strict JSON-only preamble
    log.warn?.('designProgram: first Opus reply not valid JSON; retrying with strict directive');
    result = await callOpus(
      systemPrompt,
      'IMPORTANT: respond with ONLY the JSON object — no prose, no markdown. ' + userPrompt,
      callOpts,
    );
    if (result.is_error) return { ok: false, error_class: result.error_class, reason: result.text };
    try { programData = parseOpusJson(result.text); }
    catch { return { ok: false, reason: 'Opus returned invalid JSON twice' }; }
  }

  const shapeErr = validateProgramShape(programData);
  if (shapeErr) return { ok: false, reason: shapeErr };

  // Step 4 — Classify picks (first pass)
  const novelList = [];
  const droppedList = [];
  const outsidePicks = [];

  const classify = (firstPass) => {
    novelList.length = 0;
    droppedList.length = 0;
    outsidePicks.length = 0;
    for (const [day, session] of Object.entries(programData.weekly_template)) {
      const exs = session.exercises || [];
      const survivors = [];
      for (let idx = 0; idx < exs.length; idx++) {
        const ex = exs[idx];
        const resolved = resolveExerciseName(ex.name, allTemplates, usedTemplateIdSet);
        if (!resolved) {
          outsidePicks.push({ day, idx, name: ex.name });
          if (!firstPass) {
            droppedList.push({ day, name: ex.name, reason: 'no Hevy template match after retry' });
          }
          continue;
        }
        ex.name = resolved.canonical_title;
        ex.template_id = resolved.template_id;
        if (resolved.muscle_group) ex.muscle_group = resolved.muscle_group;
        if (!resolved.was_used) {
          novelList.push({
            day,
            exerciseIndex: survivors.length,
            name: resolved.canonical_title,
            muscle_group: resolved.muscle_group,
            template_id: resolved.template_id,
          });
        }
        survivors.push(ex);
      }
      session.exercises = survivors;
    }
  };

  classify(true);

  // Step 5 — OUTSIDE_HEVY retry (once)
  if (outsidePicks.length > 0) {
    log.warn?.(`designProgram: ${outsidePicks.length} outside-pool picks; retrying with stronger directive`);
    const rejected = outsidePicks.map((p) => `"${p.name}"`).join(', ');
    const retryPrompt = `The exercises ${rejected} from your previous response are NOT in the allowed pools. ` +
      `Re-design the program picking ONLY from the USED and RELEVANT_HEVY pools listed in the system prompt. ` +
      'Return the SAME JSON schema. Respond with ONLY JSON, no prose.\n\nOriginal user prompt:\n' + userPrompt;
    const retry = await callOpus(systemPrompt, retryPrompt, callOpts);
    if (!retry.is_error) {
      try {
        programData = parseOpusJson(retry.text);
        const shapeErr2 = validateProgramShape(programData);
        if (!shapeErr2) {
          classify(false);
        } else {
          log.warn?.(`designProgram: retry shape invalid: ${shapeErr2}`);
        }
      } catch {
        log.warn?.('designProgram: retry JSON parse failed');
        classify(false);
      }
    } else {
      log.warn?.(`designProgram: retry Opus error: ${retry.error_class}`);
      classify(false);
    }
  }

  // Step 6 — Default volume_progression if missing
  if (!programData.volume_progression) {
    programData.volume_progression = defaultVolumeProgression(programData.duration_weeks);
  }

  // Re-number novelList exerciseIndex now that survivors are settled
  // (already correct because classify() rebuilt session.exercises in order)

  // Global numbering for the approval UX is added when the caller renders
  // the approval message (cron/program-rollover.js handles this).

  // Step 7 — Persist outcome
  if (novelList.length === 0) {
    return { ok: true, status: 'active', program: programData, droppedList };
  }

  const payload = {
    program: programData,
    novelList,
    droppedList,
    createdAt: Date.now(),
    designedAgainstWorkoutCountAtTime: workouts.length,
  };
  setPendingProgram(config, payload);
  return { ok: true, status: 'pending', novelList, droppedList, program: programData };
}

export { ERROR_CLASSES };
