/**
 * Brain tool: create_program
 *
 * Calls Opus via lib/claude.js to generate a periodized training program.
 * Validates the output against the program JSON schema before storing.
 */
import { z } from 'zod';
import { ensureDb, getActiveGoals, createProgram, getCachedWorkouts, getAllExerciseTemplates } from '../lib/db.js';
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
        "sets": number (required),
        "rep_range": "string (required) — e.g. '8-10'",
        "rpe_target": number (optional) — 1-10
      }]
    }
  },
  "progression_notes": "string — how to progress week to week",
  "deload_protocol": "string — when and how to deload"
}

Keys in weekly_template MUST be day names: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.
Do NOT include rest days in the template — only training days.
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

    // Build prompt for Opus
    const systemPrompt = `You are an expert strength and conditioning coach designing a periodized training program.
${PROGRAM_SCHEMA_DESCRIPTION}`;

    const userPrompt = `Design a training program based on:

GOALS:
${goals.map(g => `- ${g.goal_text}${g.category ? ` [${g.category}]` : ''}${g.target_date ? ` (target: ${g.target_date})` : ''}`).join('\n')}

RECENT TRAINING HISTORY (last 30 days):
${historyContext}

${args.context ? `ADDITIONAL CONTEXT:\n${args.context}` : ''}

Design a periodized program. Choose appropriate split, frequency, exercise selection, and rep schemes for these goals.`;

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

${programData.progression_notes ? `Progression: ${programData.progression_notes}` : ''}

The program is now active. Your morning workouts will follow this plan.`;
  },
};
