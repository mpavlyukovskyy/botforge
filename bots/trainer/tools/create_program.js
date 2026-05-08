/**
 * Brain tool: create_program
 *
 * Calls Opus via lib/claude.js to generate a periodized training program.
 * Validates the output against the program JSON schema before storing.
 */
import { z } from 'zod';
import { ensureDb, getActiveGoals, createProgram, getCachedWorkouts, getAllExerciseTemplates, getRecentProgramHistory, getAllExerciseConfigs } from '../lib/db.js';
import { callOpus } from '../lib/claude.js';

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
        "name": "string (required) — must match common exercise names",
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

Keys in weekly_template MUST be day names: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.
Do NOT include rest days in the template — only training days.
Design exercises at MEV (minimum effective volume) for week 1 — the system will automatically ramp volume each week.
Respond with ONLY the JSON, no markdown fences, no explanation.
`;

export default {
  name: 'create_program',
  description: 'Design a new periodized training program based on current goals and training history. Uses AI to generate the program structure.',
  schema: {
    context: z.string().optional().describe('Additional context about preferences, equipment, schedule, or injuries'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    // Gather goals
    const goals = getActiveGoals(ctx.config);
    if (goals.length === 0) {
      return 'No active goals set. Set goals first with /goals before creating a program.';
    }

    // Gather recent workout history for context
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const recentWorkouts = getCachedWorkouts(ctx.config, startDate, endDate);

    const historyContext = recentWorkouts.length > 0
      ? recentWorkouts.slice(0, 10).map(w => {
          const exercises = w.exercises_json ? JSON.parse(w.exercises_json) : [];
          return `${w.date}: ${w.title} — ${exercises.map(e => e.title).join(', ')}`;
        }).join('\n')
      : 'No recent workout history available.';

    // Gather exercise rotation context from previous programs
    let rotationContext = '';
    try {
      const history = getRecentProgramHistory(ctx.config, 2);
      if (history.length > 0) {
        const lines = history.map(h => {
          let line = `- ${h.exercise_title}: ${h.final_status || 'unknown'}`;
          if (h.final_weight_kg) line += ` @ ${h.final_weight_kg}kg`;
          if (h.final_status === 'stalled') {
            line += ' -> consider swapping for a biomechanically similar variant';
          } else if (h.final_status === 'progressing') {
            line += ' -> keep in program';
          }
          return line;
        });
        rotationContext = `\nPREVIOUS PROGRAM EXERCISES:\n${lines.join('\n')}\n\nFor stalled exercises, substitute with a biomechanically similar variant that targets the same muscle group from a different angle or strength curve. For progressing exercises, keep them.`;
      }
    } catch { /* skip */ }

    // Build prompt for Opus
    const systemPrompt = `You are an expert strength and conditioning coach designing a periodized training program.
${PROGRAM_SCHEMA_DESCRIPTION}`;

    const userPrompt = `Design a training program based on:

GOALS:
${goals.map(g => `- ${g.goal_text}${g.category ? ` [${g.category}]` : ''}${g.target_date ? ` (target: ${g.target_date})` : ''}`).join('\n')}

RECENT TRAINING HISTORY (last 30 days):
${historyContext}
${rotationContext}
${args.context ? `ADDITIONAL CONTEXT:\n${args.context}` : ''}

Design a periodized program. Choose appropriate split, frequency, exercise selection, and rep schemes for these goals. Design exercise volumes at MEV for week 1 — the system will automatically add sets each week. Include a volume_progression field with additive_ramp strategy.`;

    const result = await callOpus(systemPrompt, userPrompt, { timeoutMs: 180_000 });

    if (result.is_error) {
      return `Failed to generate program: ${result.text}`;
    }

    // Parse and validate JSON
    let programData;
    try {
      // Strip markdown code fences if present
      const cleaned = result.text
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
      programData = JSON.parse(cleaned);
    } catch {
      return `Program generation returned invalid JSON. Please try again.`;
    }

    // Validate required fields
    if (!programData.block_name || !programData.duration_weeks || !programData.weekly_template) {
      return 'Generated program is missing required fields. Please try again.';
    }

    // Validate weekly template keys are day names
    const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const templateDays = Object.keys(programData.weekly_template);
    for (const day of templateDays) {
      if (!validDays.includes(day)) {
        return `Invalid day name "${day}" in program. Must be Monday-Sunday.`;
      }
    }

    // Validate exercise names against cached Hevy templates
    const templates = getAllExerciseTemplates(ctx.config);
    if (templates.length > 0) {
      const titleMap = new Map(templates.map(t => [t.title.toLowerCase(), t.title]));
      const invalid = [];
      for (const [day, session] of Object.entries(programData.weekly_template)) {
        for (const ex of session.exercises || []) {
          if (!titleMap.has(ex.name.toLowerCase())) {
            invalid.push(`${day}: ${ex.name}`);
          }
        }
      }
      if (invalid.length > 0) {
        return `Program generated but ${invalid.length} exercise(s) don't match Hevy library:\n${invalid.join('\n')}\n\nRun /sync to update templates, then try again.`;
      }
    }

    // Ensure volume_progression exists
    if (!programData.volume_progression) {
      programData.volume_progression = {
        strategy: 'additive_ramp',
        sets_added_per_week: 1,
        deload_week: Math.min(4, programData.duration_weeks),
        deload_volume_pct: 50,
        rpe_start: 7,
        rpe_end: 9,
      };
    }

    // Validate push:pull ratio
    let balanceWarning = '';
    try {
      const configs = getAllExerciseConfigs(ctx.config);
      const configMap = new Map(configs.map(c => [c.exercise_title.toLowerCase(), c]));
      balanceWarning = validateMovementBalance(programData, configMap);
    } catch { /* skip validation */ }

    // Store program
    const title = programData.block_name;
    const goalsSnapshot = JSON.stringify(goals.map(g => g.goal_text));
    const validFrom = new Date().toISOString().slice(0, 10);

    createProgram(
      ctx.config,
      title,
      JSON.stringify(programData),
      goalsSnapshot,
      programData.duration_weeks,
      validFrom
    );

    // Format response
    const daysSummary = templateDays.map(d => {
      const s = programData.weekly_template[d];
      return `  ${d}: ${s.name} (${s.exercises?.length || 0} exercises)`;
    }).join('\n');

    return `Program created: "${title}"
${programData.duration_weeks} weeks, ${programData.days_per_week} days/week, ${programData.split} split

Schedule:
${daysSummary}

Volume progression: ${programData.volume_progression?.strategy === 'additive_ramp' ? `+${programData.volume_progression.sets_added_per_week} set/exercise/week, deload week ${programData.volume_progression.deload_week}` : 'none'}
${programData.progression_notes ? `Progression: ${programData.progression_notes}` : ''}
${balanceWarning ? `\n${balanceWarning}` : ''}
The program is now active. Your morning workouts will follow this plan.`;
  },
};

// ─── Movement pattern classification for push:pull validation ────────────

const PUSH_PATTERNS = [/bench press/i, /push.?up/i, /shoulder press/i, /overhead press/i, /military press/i, /incline press/i, /decline press/i, /chest fly/i, /pec deck/i, /cable cross/i, /tricep/i, /pushdown/i, /skull crush/i, /dip/i, /kickback/i, /lateral raise/i, /arnold press/i];
const PULL_PATTERNS = [/row/i, /pull.?up/i, /pulldown/i, /lat pull/i, /chin.?up/i, /face pull/i, /rear delt/i, /curl/i, /preacher/i, /hammer curl/i, /shrug/i, /upright row/i];

function classifyMovementPattern(exerciseName) {
  const name = exerciseName || '';
  if (PUSH_PATTERNS.some(p => p.test(name))) return 'push';
  if (PULL_PATTERNS.some(p => p.test(name))) return 'pull';
  return 'other';
}

function validateMovementBalance(programData) {
  let pushSets = 0;
  let pullSets = 0;

  for (const session of Object.values(programData.weekly_template || {})) {
    for (const ex of (session.exercises || [])) {
      const pattern = classifyMovementPattern(ex.name);
      if (pattern === 'push') pushSets += ex.sets;
      else if (pattern === 'pull') pullSets += ex.sets;
    }
  }

  if (pullSets === 0 && pushSets === 0) return '';

  const ratio = pushSets / (pullSets || 1);
  if (ratio > 1.2) {
    return `Note: Push:pull ratio is ${ratio.toFixed(1)}:1 (${pushSets} push sets vs ${pullSets} pull sets) — consider adding more pulling volume for shoulder health.`;
  }
  return '';
}
