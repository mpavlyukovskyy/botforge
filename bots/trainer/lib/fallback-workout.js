/**
 * Fallback workout picker. Used when the LLM is unavailable (spending cap,
 * persistent 5xx, etc.) — keeps the morning_workout flow alive instead of
 * surfacing a raw error to Mark.
 *
 * Strategy:
 *   - Red recovery → recovery.json regardless of day
 *   - Otherwise use a fixed weekly pattern:
 *       Mon → upper / Tue → lower / Wed → push / Thu → pull / Fri → legs
 *       Sat → upper / Sun → recovery
 *   - Picker returns null if it can't find a template (caller must handle)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _here = dirname(fileURLToPath(import.meta.url));
const FALLBACK_DIR = join(_here, '..', 'data', 'fallback-workouts');

const PATTERN = {
  Monday: 'upper',
  Tuesday: 'lower',
  Wednesday: 'push',
  Thursday: 'pull',
  Friday: 'legs',
  Saturday: 'upper',
  Sunday: 'recovery',
};

export function pickFallbackTemplateName(dayName, readiness) {
  if (readiness === 'red') return 'recovery';
  return PATTERN[dayName] || 'upper';
}

export async function loadFallbackWorkout(templateName) {
  try {
    const raw = await readFile(join(FALLBACK_DIR, `${templateName}.json`), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Convenience: given today's day-of-week + readiness, load the right template.
 * Returns the workout object or null on failure.
 */
export async function getFallbackForToday(dayName, readiness) {
  const name = pickFallbackTemplateName(dayName, readiness);
  return loadFallbackWorkout(name);
}

/**
 * Format a fallback workout as a human-readable Telegram message.
 */
export function formatFallbackCard(workout) {
  if (!workout) return null;
  const header = `*${workout.name}*\n_${workout.focus}_\n`;
  const lines = workout.exercises
    .map((ex) => `• ${ex.title} — ${ex.sets}×${ex.reps} @ RPE ${ex.rpe}`)
    .join('\n');
  const footer = '\n\n_AI coach is offline. This is a backup workout. Send /workout to retry once the AI is back._';
  return header + lines + footer;
}
