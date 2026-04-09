/**
 * Workout history analyzer — pure computation, no side effects.
 *
 * Input: array of raw Hevy API workout objects + optional template lookup.
 * Output: structured metrics + inferred goals.
 */

// ─── Muscle group mapping from Hevy primary_muscle_group values ──────────

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
  return MUSCLE_GROUP_MAP[key] || 'unknown';
}

// ─── Title-based muscle inference (fallback when templates missing) ──────

const TITLE_MUSCLE_PATTERNS = [
  [/squat|leg press|leg extension|leg curl|lunge|calf|hip thrust|bulgarian|glute|romanian deadlift|rdl|step.?up|hamstring/i, 'legs'],
  [/bench press|chest fly|pec deck|cable cross|push.?up|chest press|incline press|decline press|dumbbell fly/i, 'chest'],
  [/row|pull.?up|pulldown|lat pull|chin.?up|deadlift|back extension|t.?bar|shrug/i, 'back'],
  [/shoulder press|lateral raise|overhead press|face pull|upright row|military press|arnold press|rear delt/i, 'shoulders'],
  [/curl|tricep|skull crush|hammer curl|pushdown|dip|kickback|preacher|concentration/i, 'arms'],
  [/crunch|plank|\bab\b|sit.?up|leg raise|woodchop/i, 'core'],
];

function inferMuscleGroupFromTitle(title) {
  if (!title) return 'unknown';
  for (const [pattern, group] of TITLE_MUSCLE_PATTERNS) {
    if (pattern.test(title)) return group;
  }
  return 'unknown';
}

// ─── Main analysis function ──────────────────────────────────────────────

/**
 * Analyze an array of raw Hevy workout objects.
 *
 * @param {Array} workouts - Raw Hevy API workout objects
 * @param {Map} [templateLookup] - Map<template_id, { muscle_group }>
 * @returns {object|null} Metrics object, or null if no workouts
 */
export function analyzeWorkoutHistory(workouts, templateLookup = new Map()) {
  if (!workouts || workouts.length === 0) return null;

  // Sort by date ascending
  const sorted = [...workouts].sort(
    (a, b) => new Date(a.start_time) - new Date(b.start_time)
  );

  const firstDate = sorted[0].start_time?.slice(0, 10);
  const lastDate = sorted[sorted.length - 1].start_time?.slice(0, 10);
  const spanDays = Math.max(
    1,
    Math.round((new Date(lastDate) - new Date(firstDate)) / 86400000)
  );

  // ── Frequency ──────────────────────────────────────────────────────────
  const weekdayDist = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
  for (const w of sorted) {
    const day = new Date(w.start_time).getDay();
    weekdayDist[day]++;
  }
  const avgPerWeek = Math.round((sorted.length / (spanDays / 7)) * 10) / 10;

  // ── Exercise frequency + muscle distribution ───────────────────────────
  const exerciseCount = {};
  const exerciseVolume = {};
  const muscleVolume = {};
  const allReps = [];

  for (const w of sorted) {
    for (const ex of w.exercises || []) {
      const name = ex.title || 'Unknown';
      const templateId = ex.exercise_template_id;
      exerciseCount[name] = (exerciseCount[name] || 0) + 1;

      const template = templateLookup.get(templateId);
      const muscleGroup = template
        ? normalizeMuscleGroup(template.muscle_group)
        : inferMuscleGroupFromTitle(name);

      let exVol = 0;
      for (const s of ex.sets || []) {
        if (s.type !== 'normal' && s.type !== 'warmup') continue;
        const weight = s.weight_kg || 0;
        const reps = s.reps || 0;
        if (s.type === 'normal') {
          exVol += weight * reps;
          allReps.push(reps);
        }
      }

      exerciseVolume[name] = (exerciseVolume[name] || 0) + exVol;
      muscleVolume[muscleGroup] = (muscleVolume[muscleGroup] || 0) + exVol;
    }
  }

  // Top 15 exercises by frequency
  const exerciseFrequency = Object.entries(exerciseCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  // Top 10 exercises by total volume
  const topExercises = Object.entries(exerciseVolume)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, volume]) => ({ name, volume: Math.round(volume) }));

  // Muscle distribution as percentages
  const totalVol = Object.values(muscleVolume).reduce((s, v) => s + v, 0) || 1;
  const muscleDistribution = {};
  for (const [group, vol] of Object.entries(muscleVolume)) {
    muscleDistribution[group] = Math.round((vol / totalVol) * 100);
  }

  // ── Rep range profile ──────────────────────────────────────────────────
  const repRanges = { '1-5': 0, '6-8': 0, '8-12': 0, '12-15': 0, '15+': 0 };
  for (const r of allReps) {
    if (r <= 5) repRanges['1-5']++;
    else if (r <= 8) repRanges['6-8']++;
    else if (r <= 12) repRanges['8-12']++;
    else if (r <= 15) repRanges['12-15']++;
    else repRanges['15+']++;
  }
  const totalSets = allReps.length || 1;
  const repRangeProfile = {};
  for (const [range, count] of Object.entries(repRanges)) {
    repRangeProfile[range] = Math.round((count / totalSets) * 100);
  }

  // ── Volume trends (last 8 weeks) ──────────────────────────────────────
  const weeklyVolume = {};
  for (const w of sorted) {
    const date = new Date(w.start_time);
    // Week key: ISO week start (Monday)
    const dayOfWeek = (date.getDay() + 6) % 7;
    const monday = new Date(date);
    monday.setDate(monday.getDate() - dayOfWeek);
    const weekKey = monday.toISOString().slice(0, 10);

    let wVol = 0;
    for (const ex of w.exercises || []) {
      for (const s of ex.sets || []) {
        if (s.type === 'normal') wVol += (s.weight_kg || 0) * (s.reps || 0);
      }
    }
    weeklyVolume[weekKey] = (weeklyVolume[weekKey] || 0) + wVol;
  }

  const weekKeys = Object.keys(weeklyVolume).sort().slice(-8);
  const weeklyData = weekKeys.map(k => ({
    week: k,
    volume: Math.round(weeklyVolume[k]),
  }));

  // Simple trend: compare first half avg to second half avg
  let direction = 'stable';
  if (weeklyData.length >= 4) {
    const mid = Math.floor(weeklyData.length / 2);
    const firstHalf =
      weeklyData.slice(0, mid).reduce((s, w) => s + w.volume, 0) / mid;
    const secondHalf =
      weeklyData.slice(mid).reduce((s, w) => s + w.volume, 0) /
      (weeklyData.length - mid);
    if (secondHalf > firstHalf * 1.1) direction = 'increasing';
    else if (secondHalf < firstHalf * 0.9) direction = 'decreasing';
  }

  // ── Split detection ────────────────────────────────────────────────────
  const split = detectSplit(sorted, templateLookup);

  // ── Progression (top 5 exercises) ──────────────────────────────────────
  const progression = computeProgression(sorted, topExercises.slice(0, 5));

  // ── Duration ───────────────────────────────────────────────────────────
  const durations = sorted
    .filter(w => w.start_time && w.end_time)
    .map(w => (new Date(w.end_time) - new Date(w.start_time)) / 60000);
  const avgDuration =
    durations.length > 0
      ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
      : null;

  return {
    date_range: { first: firstDate, last: lastDate, span_days: spanDays },
    frequency: {
      total_workouts: sorted.length,
      avg_per_week: avgPerWeek,
      weekday_distribution: weekdayDist,
    },
    split,
    exercise_frequency: exerciseFrequency,
    muscle_distribution: muscleDistribution,
    volume_trends: { weeks: weeklyData, direction },
    top_exercises: topExercises,
    progression,
    rep_range_profile: repRangeProfile,
    duration: avgDuration,
  };
}

// ─── Split detection ─────────────────────────────────────────────────────

const SPLIT_KEYWORDS = {
  upper: ['upper', 'chest', 'shoulder', 'arm', 'back'],
  lower: ['lower', 'leg', 'squat', 'deadlift', 'glute'],
  push: ['push', 'chest', 'shoulder', 'tricep', 'bench', 'press'],
  pull: ['pull', 'back', 'bicep', 'row', 'lat'],
  legs: ['leg', 'squat', 'deadlift', 'lunge', 'glute', 'calf'],
};

function detectSplit(workouts, templateLookup) {
  // Title-based classification
  const titleCounts = { upper: 0, lower: 0, push: 0, pull: 0, legs: 0 };
  const titleClassified = [];

  for (const w of workouts) {
    const title = (w.title || '').toLowerCase();
    const matched = [];

    for (const [cat, keywords] of Object.entries(SPLIT_KEYWORDS)) {
      if (keywords.some(kw => title.includes(kw))) {
        titleCounts[cat]++;
        matched.push(cat);
      }
    }

    // Muscle-based classification
    const muscles = new Set();
    for (const ex of w.exercises || []) {
      const tmpl = templateLookup.get(ex.exercise_template_id);
      if (tmpl) muscles.add(normalizeMuscleGroup(tmpl.muscle_group));
    }
    titleClassified.push({ title, matched, muscles: [...muscles] });
  }

  const total = workouts.length;

  // Check Upper/Lower FIRST (strongest signal from explicit title keywords)
  if (titleCounts.upper + titleCounts.lower > total * 0.5) {
    const ulCount = titleCounts.upper + titleCounts.lower;
    const confidence =
      ulCount > total * 0.7 ? 'high' : ulCount > total * 0.5 ? 'medium' : 'low';
    return {
      type: 'Upper/Lower',
      confidence,
      evidence: `${titleCounts.upper} upper, ${titleCounts.lower} lower sessions`,
    };
  }

  // Check for PPL (merge lower into legs for detection)
  const pplLegs = titleCounts.legs + titleCounts.lower;
  if (
    titleCounts.push + titleCounts.pull + pplLegs >
    total * 0.5
  ) {
    const pplCount = titleCounts.push + titleCounts.pull + pplLegs;
    const confidence =
      pplCount > total * 0.7 ? 'high' : pplCount > total * 0.5 ? 'medium' : 'low';
    return {
      type: 'Push/Pull/Legs',
      confidence,
      evidence: `${titleCounts.push} push, ${titleCounts.pull} pull, ${pplLegs} legs sessions`,
    };
  }

  // Check for full body (every session hits 3+ muscle groups)
  const fullBodyCount = titleClassified.filter(w => w.muscles.length >= 3).length;
  if (fullBodyCount > total * 0.6) {
    const confidence =
      fullBodyCount > total * 0.7 ? 'high' : 'medium';
    return {
      type: 'Full Body',
      confidence,
      evidence: `${fullBodyCount}/${total} sessions hit 3+ muscle groups`,
    };
  }

  // Check for bro split (single muscle focus per session)
  const singleMuscle = titleClassified.filter(
    w => w.muscles.length === 1 || w.muscles.length === 2
  ).length;
  if (singleMuscle > total * 0.5) {
    return {
      type: 'Body Part Split',
      confidence: singleMuscle > total * 0.7 ? 'high' : 'medium',
      evidence: `${singleMuscle}/${total} sessions focus on 1-2 muscle groups`,
    };
  }

  return {
    type: 'Mixed/Custom',
    confidence: 'low',
    evidence: 'No clear split pattern detected from workout titles or muscle groups',
  };
}

// ─── Progression analysis ────────────────────────────────────────────────

function computeProgression(sortedWorkouts, topExercises) {
  const results = [];

  for (const { name } of topExercises) {
    const performances = [];

    for (const w of sortedWorkouts) {
      for (const ex of w.exercises || []) {
        if ((ex.title || '').toLowerCase() !== name.toLowerCase()) continue;
        const normalSets = (ex.sets || []).filter(s => s.type === 'normal');
        if (normalSets.length === 0) continue;

        const topSet = normalSets.sort(
          (a, b) => (b.weight_kg || 0) - (a.weight_kg || 0)
        )[0];
        performances.push({
          date: w.start_time?.slice(0, 10),
          weight: topSet.weight_kg || 0,
          reps: topSet.reps || 0,
        });
      }
    }

    if (performances.length < 3) {
      results.push({ exercise: name, data_points: performances.length, trend: 'insufficient data' });
      continue;
    }

    // Compare earliest 1/3 vs recent 1/3
    const third = Math.max(1, Math.floor(performances.length / 3));
    const early = performances.slice(0, third);
    const recent = performances.slice(-third);

    const earlyAvg = early.reduce((s, p) => s + p.weight, 0) / early.length;
    const recentAvg = recent.reduce((s, p) => s + p.weight, 0) / recent.length;
    const change = earlyAvg > 0 ? Math.round(((recentAvg - earlyAvg) / earlyAvg) * 100) : 0;

    let trend = 'stable';
    if (change > 5) trend = 'progressing';
    else if (change < -5) trend = 'regressing';

    results.push({
      exercise: name,
      data_points: performances.length,
      early_avg_kg: Math.round(earlyAvg * 10) / 10,
      recent_avg_kg: Math.round(recentAvg * 10) / 10,
      change_pct: change,
      trend,
    });
  }

  return results;
}

// ─── Goal inference ──────────────────────────────────────────────────────

/**
 * Infer training goals from computed metrics.
 *
 * @param {object} metrics - Output from analyzeWorkoutHistory
 * @returns {Array<{ goal_text: string, category: string, confidence: number }>}
 */
export function inferGoals(metrics) {
  if (!metrics) return [];

  const goals = [];

  // Rep range → primary training goal
  const { rep_range_profile } = metrics;
  const hypertrophyPct = (rep_range_profile['8-12'] || 0) + (rep_range_profile['6-8'] || 0);
  const strengthPct = rep_range_profile['1-5'] || 0;
  const endurancePct = (rep_range_profile['12-15'] || 0) + (rep_range_profile['15+'] || 0);

  if (hypertrophyPct >= 50) {
    goals.push({
      goal_text: 'Build muscle mass (hypertrophy-focused training)',
      category: 'hypertrophy',
      confidence: Math.min(0.95, hypertrophyPct / 100 + 0.2),
    });
  } else if (strengthPct >= 30) {
    goals.push({
      goal_text: 'Build maximal strength',
      category: 'strength',
      confidence: Math.min(0.95, strengthPct / 100 + 0.3),
    });
  }

  if (endurancePct >= 30) {
    goals.push({
      goal_text: 'Improve muscular endurance',
      category: 'endurance',
      confidence: Math.min(0.9, endurancePct / 100 + 0.2),
    });
  }

  // Frequency → commitment level
  const { frequency } = metrics;
  if (frequency.avg_per_week >= 5) {
    goals.push({
      goal_text: `Maintain high training frequency (${frequency.avg_per_week}x/week)`,
      category: 'consistency',
      confidence: 0.85,
    });
  } else if (frequency.avg_per_week >= 3) {
    goals.push({
      goal_text: `Train consistently ${Math.round(frequency.avg_per_week)}x per week`,
      category: 'consistency',
      confidence: 0.75,
    });
  }

  // Volume trend → progressive overload
  if (metrics.volume_trends.direction === 'increasing') {
    goals.push({
      goal_text: 'Continue progressive overload (volume trending up)',
      category: 'progression',
      confidence: 0.8,
    });
  }

  // Muscle emphasis detection
  const { muscle_distribution } = metrics;
  const topMuscle = Object.entries(muscle_distribution)
    .filter(([g]) => g !== 'unknown')
    .sort((a, b) => b[1] - a[1])[0];
  if (topMuscle && topMuscle[1] >= 35) {
    goals.push({
      goal_text: `Prioritize ${topMuscle[0]} development (${topMuscle[1]}% of volume)`,
      category: 'body-focus',
      confidence: 0.7,
    });
  }

  // Sort by confidence, take top 4
  goals.sort((a, b) => b.confidence - a.confidence);
  return goals.slice(0, 4);
}
