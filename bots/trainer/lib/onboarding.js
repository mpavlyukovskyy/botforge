/**
 * Onboarding analysis pipeline
 *
 * Fetches full Hevy history, analyzes patterns, calls Opus for narrative,
 * stores results, and sends to Telegram.
 *
 * CRITICAL: Takes individual values (config, log, adapter, chatId), NOT ctx.
 * This runs async after lifecycle execute() returns — ctx may not persist.
 */
import { getAllWorkouts, syncTemplatesFromWorkouts, parseWorkoutForCache } from './hevy-client.js';
import {
  upsertOnboardingAnalysis,
  upsertWorkoutCache,
  getExerciseTemplate,
  upsertExerciseTemplate,
  getAllExerciseTemplates,
} from './db.js';
import { analyzeWorkoutHistory, inferGoals } from './workout-analyzer.js';
import { callOpus } from './claude.js';

/**
 * Run the full onboarding analysis pipeline.
 */
export async function runOnboardingAnalysis(config, log, adapter, chatId) {
  // 1. Mark as pending
  upsertOnboardingAnalysis(config, { status: 'pending' });
  log.info('Onboarding: fetching full workout history from Hevy...');

  // 2. Fetch all workouts from Hevy API
  const allWorkouts = await getAllWorkouts();
  log.info(`Onboarding: fetched ${allWorkouts.length} workouts`);

  // 3. Cache workouts in DB
  for (const w of allWorkouts) {
    const cached = parseWorkoutForCache(w);
    upsertWorkoutCache(config, cached);
  }

  // 4. Sync exercise templates
  const templateResult = await syncTemplatesFromWorkouts(
    allWorkouts,
    (id) => getExerciseTemplate(config, id),
    (tmpl) => upsertExerciseTemplate(config, tmpl)
  );
  log.info(`Onboarding: synced ${templateResult.fetched} new exercise templates`);

  if (templateResult.fetched === 0 && templateResult.total > 0) {
    log.warn(`Onboarding: 0/${templateResult.total} templates fetched — Hevy API may be rejecting template requests. Using title-based muscle inference.`);
  }

  // 5. Build template lookup for analyzer
  const templates = getAllExerciseTemplates(config);
  const templateLookup = new Map();
  for (const t of templates) {
    templateLookup.set(t.id, { muscle_group: t.muscle_group });
  }

  // 6. Analyze (using raw Hevy objects, not cached format)
  const metrics = analyzeWorkoutHistory(allWorkouts, templateLookup);
  const goals = inferGoals(metrics);

  // 7. Handle zero workouts
  if (!metrics) {
    upsertOnboardingAnalysis(config, {
      status: 'complete',
      workout_count: 0,
    });
    log.info('Onboarding: no workouts found, skipping narrative');
    if (chatId) {
      await adapter.send({
        chatId,
        text: "I couldn't find any workout history in Hevy. Let's start from scratch — tell me what you're training for!",
      });
    }
    return;
  }

  // 8. Call Opus for narrative
  let narrative;
  const opusResult = await callOpus(
    `You are an expert strength coach reviewing a new client's workout history.
Write a concise training analysis (max 2500 chars) covering:
- Training frequency and consistency
- Split pattern and programming approach
- Exercise selection: strengths and blind spots
- Progression: where they're getting stronger, where they've stalled
- 2-3 inferred goals based on the data
Use second person ("you"). Be specific with numbers. No markdown formatting — plain text only, suitable for Telegram.`,
    JSON.stringify(metrics) + '\n\nInferred goals: ' + JSON.stringify(goals),
    { timeoutMs: 180_000 }
  );

  if (opusResult.is_error) {
    log.warn(`Onboarding: Opus failed (${opusResult.text}), using fallback narrative`);
    narrative = buildFallbackNarrative(metrics, goals);
  } else {
    narrative = opusResult.text;
  }

  // 9. Store complete analysis
  upsertOnboardingAnalysis(config, {
    status: 'complete',
    workout_count: allWorkouts.length,
    metrics_json: metrics,
    narrative,
    inferred_goals_json: goals,
  });
  log.info('Onboarding: analysis complete');

  // 10. Send to Telegram
  if (chatId) {
    await adapter.send({ chatId, text: narrative });

    if (goals.length > 0) {
      const goalList = goals
        .map((g, i) => `${i + 1}. ${g.goal_text}`)
        .join('\n');

      await adapter.send({
        chatId,
        text: `Based on your history, I'd suggest these goals:\n${goalList}\n\nDoes this look right?`,
        inlineKeyboard: [[
          { text: 'Confirm', callbackData: 'ob:confirm' },
          { text: 'Adjust', callbackData: 'ob:adjust' },
          { text: 'Start fresh', callbackData: 'ob:fresh' },
        ]],
      });
    }
  }
}

/**
 * Template-based fallback narrative when Opus is unavailable.
 */
function buildFallbackNarrative(metrics, goals) {
  const { frequency, split, top_exercises, volume_trends, rep_range_profile, duration } = metrics;

  const topNames = top_exercises.slice(0, 5).map(e => e.name).join(', ');
  const goalLines = goals.map(g => `- ${g.goal_text}`).join('\n');

  return [
    `I've analyzed your ${frequency.total_workouts} workouts over ${metrics.date_range.span_days} days.`,
    '',
    `Training frequency: ${frequency.avg_per_week} sessions/week`,
    `Split: ${split.type} (${split.confidence} confidence)`,
    duration ? `Average session: ${duration} minutes` : '',
    `Volume trend: ${volume_trends.direction}`,
    '',
    `Top exercises by volume: ${topNames}`,
    '',
    `Rep range breakdown: ${Object.entries(rep_range_profile).map(([r, p]) => `${r}: ${p}%`).join(', ')}`,
    '',
    goals.length > 0 ? `Suggested goals:\n${goalLines}` : '',
  ].filter(Boolean).join('\n');
}
