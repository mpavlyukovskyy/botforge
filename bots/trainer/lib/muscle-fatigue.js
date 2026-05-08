/**
 * Per-muscle-group fatigue tracking with exponential decay model.
 *
 * Uses variable half-lives by exercise type (compound=72-96h, isolation=48h)
 * and weights by classification (compound generates more fatigue per set than isolation).
 */

import { inferMuscleGroupFromTitle } from './exercise-classifier.js';

// ─── Muscle group normalization ─────────────────────────────────────────

const MUSCLE_GROUP_MAP = {
  chest: 'chest',
  biceps: 'arms',
  triceps: 'arms',
  forearms: 'arms',
  shoulders: 'shoulders',
  lats: 'back',
  upper_back: 'back',
  lower_back: 'back',
  traps: 'back',
  quads: 'legs',
  hamstrings: 'legs',
  glutes: 'legs',
  calves: 'legs',
  abdominals: 'core',
  obliques: 'core',
  cardio: 'cardio',
  full_body: 'full_body',
  other: 'other',
};

function normalizeMuscleGroup(raw) {
  if (!raw) return 'unknown';
  const key = raw.toLowerCase().replace(/\s+/g, '_');
  return MUSCLE_GROUP_MAP[key] || raw.toLowerCase();
}

// ─── Percentile helper ──────────────────────────────────────────────────

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

// ─── Main computation ───────────────────────────────────────────────────

/**
 * Compute per-muscle-group fatigue levels based on recent workout data.
 *
 * @param {Array} recentWorkouts - Workout cache rows with exercises_json
 * @param {Map<string, object>} exerciseConfigs - Map of exercise_title → config row
 * @param {Map<string, object>} templateLookup - Map of exercise_title → template row (for muscle_group fallback)
 * @returns {object} - { chest: 'HIGH', back: 'LOW', legs: 'MEDIUM', ... }
 */
export function computeMuscleFatigue(recentWorkouts, exerciseConfigs, templateLookup) {
  const fatigue = {};
  const now = Date.now();

  for (const w of recentWorkouts) {
    const workoutDate = w.date || w.start_time?.slice(0, 10);
    if (!workoutDate) continue;

    const workoutAge = (now - new Date(workoutDate).getTime()) / 3600000; // hours
    if (workoutAge < 0) continue; // future date, skip

    const exercises = typeof w.exercises_json === 'string'
      ? JSON.parse(w.exercises_json)
      : (w.exercises_json || []);

    for (const ex of exercises) {
      const title = ex.title || ex.name || '';
      const configRow = exerciseConfigs.get(title) || exerciseConfigs.get(title.toLowerCase());
      const fatigueWeight = configRow?.fatigue_weight ?? 1.0;
      const halfLife = configRow?.recovery_hours ?? 72;

      // Determine muscle groups
      let muscleGroups;
      if (configRow?.muscle_groups) {
        try {
          muscleGroups = typeof configRow.muscle_groups === 'string'
            ? JSON.parse(configRow.muscle_groups)
            : configRow.muscle_groups;
        } catch {
          muscleGroups = [configRow.muscle_groups];
        }
      } else {
        const tmpl = templateLookup.get(title) || templateLookup.get(title.toLowerCase());
        const mg = tmpl?.muscle_group || inferMuscleGroupFromTitle(title);
        muscleGroups = [mg];
      }

      // Calculate raw fatigue from sets
      const normalSets = (ex.sets || []).filter(s => s.type === 'normal');
      const totalLoad = normalSets.reduce((sum, s) => {
        const weight = s.weight_kg || 1; // bodyweight exercises default to 1
        const reps = s.reps || 0;
        return sum + weight * reps;
      }, 0);

      const rawFatigue = totalLoad * fatigueWeight;

      // Exponential decay based on exercise-specific half-life
      const decayFactor = Math.pow(0.5, workoutAge / halfLife);
      const decayedFatigue = rawFatigue * decayFactor;

      for (const mg of muscleGroups) {
        const normalized = normalizeMuscleGroup(mg);
        if (normalized === 'unknown' || normalized === 'other' || normalized === 'cardio') continue;
        fatigue[normalized] = (fatigue[normalized] || 0) + decayedFatigue;
      }
    }
  }

  // Normalize to HIGH/MEDIUM/LOW
  const values = Object.values(fatigue).filter(v => v > 0);
  if (values.length === 0) {
    // No recent workouts — all muscles are LOW
    return {};
  }

  const p75 = percentile(values, 75);
  const p25 = percentile(values, 25);

  const result = {};
  for (const [group, score] of Object.entries(fatigue)) {
    if (score <= 0) continue;
    result[group] = score >= p75 ? 'HIGH' : score <= p25 ? 'LOW' : 'MEDIUM';
  }
  return result;
}
