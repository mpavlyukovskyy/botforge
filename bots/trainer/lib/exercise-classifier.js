/**
 * Exercise classifier — infers category, increments, fatigue weight, recovery hours
 * from Hevy exercise template data (equipment, muscle_group, title).
 *
 * Used to auto-populate exercise_config table for exercises that don't have one.
 */

// ─── Title-based muscle inference (reused from workout-analyzer.js) ──────

const TITLE_MUSCLE_PATTERNS = [
  [/squat|leg press|leg extension|leg curl|lunge|calf|hip thrust|bulgarian|glute|romanian deadlift|rdl|step.?up|hamstring/i, 'legs'],
  [/bench press|chest fly|pec deck|cable cross|push.?up|chest press|incline press|decline press|dumbbell fly/i, 'chest'],
  [/row|pull.?up|pulldown|lat pull|chin.?up|deadlift|back extension|t.?bar|shrug/i, 'back'],
  [/shoulder press|lateral raise|overhead press|face pull|upright row|military press|arnold press|rear delt/i, 'shoulders'],
  [/curl|tricep|skull crush|hammer curl|pushdown|dip|kickback|preacher|concentration/i, 'arms'],
  [/crunch|plank|\bab\b|sit.?up|leg raise|woodchop/i, 'core'],
];

/**
 * Infer muscle group from exercise title when template data is missing.
 */
export function inferMuscleGroupFromTitle(title) {
  if (!title) return 'unknown';
  for (const [pattern, group] of TITLE_MUSCLE_PATTERNS) {
    if (pattern.test(title)) return group;
  }
  return 'unknown';
}

// ─── Equipment-based compound detection ──────────────────────────────────

const COMPOUND_PATTERNS = [
  /bench press/i, /squat/i, /deadlift/i, /overhead press/i, /military press/i,
  /row/i, /pull.?up/i, /chin.?up/i, /dip/i, /hip thrust/i, /lunge/i,
  /clean/i, /snatch/i, /jerk/i, /shoulder press/i, /leg press/i,
];

const ISOLATION_PATTERNS = [
  /curl/i, /extension/i, /fly/i, /raise/i, /kickback/i, /pushdown/i,
  /pullover/i, /pec deck/i, /face pull/i, /cable cross/i, /shrug/i,
  /calf raise/i, /concentration/i, /preacher/i, /wrist/i,
];

function isCompoundByTitle(title) {
  if (!title) return null; // unknown
  if (COMPOUND_PATTERNS.some(p => p.test(title))) return true;
  if (ISOLATION_PATTERNS.some(p => p.test(title))) return false;
  return null; // unknown
}

// ─── Main classification function ────────────────────────────────────────

/**
 * Classify an exercise based on its equipment, muscle group, and title.
 *
 * @param {string} title - Exercise name (e.g. "Barbell Bench Press")
 * @param {string} equipment - Hevy equipment field (e.g. "barbell", "dumbbell", "cable", "machine", "bodyweight")
 * @param {string} muscleGroup - Hevy primary_muscle_group field (e.g. "chest", "quads")
 * @returns {{ category: string, increment_kg: number, fatigue_weight: number, recovery_hours: number, muscle_groups: string[] }}
 */
export function classifyExercise(title, equipment, muscleGroup) {
  const eq = (equipment || '').toLowerCase().replace(/\s+/g, '_');
  const compoundByTitle = isCompoundByTitle(title);

  let category;
  let increment_kg;
  let fatigue_weight;
  let recovery_hours;

  switch (eq) {
    case 'barbell':
      category = compoundByTitle === false ? 'isolation' : 'compound';
      increment_kg = category === 'compound' ? 2.5 : 1;
      fatigue_weight = category === 'compound' ? 1.5 : 0.5;
      recovery_hours = category === 'compound' ? 72 : 48;
      break;

    case 'dumbbell':
      category = compoundByTitle === true ? 'compound' : 'isolation';
      increment_kg = category === 'compound' ? 2 : 1;
      fatigue_weight = category === 'compound' ? 1.2 : 0.5;
      recovery_hours = category === 'compound' ? 72 : 48;
      break;

    case 'cable':
      category = compoundByTitle === true ? 'compound' : 'isolation';
      increment_kg = 1;
      fatigue_weight = category === 'compound' ? 1.0 : 0.5;
      recovery_hours = 48;
      break;

    case 'machine':
      category = 'machine';
      increment_kg = 5;
      fatigue_weight = 1.0;
      recovery_hours = 72;
      break;

    case 'bodyweight':
      category = 'bodyweight';
      increment_kg = 0;
      fatigue_weight = 1.0;
      recovery_hours = 72;
      break;

    default:
      // Unknown equipment — infer from title
      category = compoundByTitle === false ? 'isolation' : 'compound';
      increment_kg = 2.5;
      fatigue_weight = category === 'compound' ? 1.5 : 0.5;
      recovery_hours = category === 'compound' ? 72 : 48;
      break;
  }

  // Determine muscle groups
  let muscle_groups;
  if (muscleGroup) {
    muscle_groups = [muscleGroup];
  } else {
    const inferred = inferMuscleGroupFromTitle(title);
    muscle_groups = inferred !== 'unknown' ? [inferred] : [];
  }

  return { category, increment_kg, fatigue_weight, recovery_hours, muscle_groups };
}
