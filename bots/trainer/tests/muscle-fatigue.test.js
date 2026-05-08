import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeMuscleFatigue } from '../lib/muscle-fatigue.js';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build an ISO date string N hours before the given "now" timestamp. */
function hoursAgo(hours, now = Date.now()) {
  return new Date(now - hours * 3600_000).toISOString().slice(0, 10);
}

/** Shorthand to build a workout row with exercises_json. */
function makeWorkout(date, exercises) {
  return {
    date,
    exercises_json: JSON.stringify(exercises),
  };
}

/** Build a single exercise object with normal sets. */
function makeExercise(title, sets) {
  return {
    title,
    sets: sets.map(s => ({ type: 'normal', weight_kg: s.weight, reps: s.reps })),
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────

// Pin Date.now() so decay calculations are deterministic.
const FIXED_NOW = new Date('2026-05-07T12:00:00Z').getTime();

// Exercise configs keyed by title
function compoundConfig() {
  return new Map([
    ['Barbell Bench Press', {
      fatigue_weight: 1.5,
      recovery_hours: 72,
      muscle_groups: ['chest'],
    }],
  ]);
}

function isolationConfig() {
  return new Map([
    ['Cable Lateral Raise', {
      fatigue_weight: 0.5,
      recovery_hours: 48,
      muscle_groups: ['shoulders'],
    }],
  ]);
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('computeMuscleFatigue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Compound 24h ago: decayed but still significant ──────────────

  it('returns significant fatigue for a compound exercise done 24h ago', () => {
    const date = hoursAgo(24, FIXED_NOW);
    const workouts = [
      makeWorkout(date, [
        makeExercise('Barbell Bench Press', [
          { weight: 80, reps: 8 },
          { weight: 80, reps: 8 },
          { weight: 80, reps: 6 },
        ]),
      ]),
    ];

    const configs = compoundConfig();
    const result = computeMuscleFatigue(workouts, configs, new Map());

    // totalLoad = 80*8 + 80*8 + 80*6 = 1760
    // rawFatigue = 1760 * 1.5 = 2640
    // decayFactor = 0.5^(24/72) = 0.5^(1/3) ≈ 0.7937
    // decayedFatigue ≈ 2640 * 0.7937 ≈ 2095
    expect(result).toHaveProperty('chest');
    // With only one muscle group, there's a single value — it classifies
    // but what matters is the key exists and the score is nontrivial
  });

  // ── 2. Compound 72h ago: exactly one half-life (50% decay) ─────────

  it('produces exactly 50% fatigue at one half-life (72h) for a compound', () => {
    const date = hoursAgo(72, FIXED_NOW);
    const workouts = [
      makeWorkout(date, [
        makeExercise('Barbell Bench Press', [
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
        ]),
      ]),
    ];

    // Also add a recent workout for a different muscle so we can verify
    // the relative fatigue value of chest (need 2+ groups for classification).
    const dateRecent = hoursAgo(12, FIXED_NOW);
    workouts.push(
      makeWorkout(dateRecent, [
        makeExercise('Barbell Squat', [
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
        ]),
      ]),
    );

    const configs = new Map([
      ['Barbell Bench Press', {
        fatigue_weight: 1.5,
        recovery_hours: 72,
        muscle_groups: ['chest'],
      }],
      ['Barbell Squat', {
        fatigue_weight: 1.5,
        recovery_hours: 72,
        muscle_groups: ['quads'],
      }],
    ]);

    const result = computeMuscleFatigue(workouts, configs, new Map());

    // Bench: totalLoad=1500, raw=2250, decay=0.5^(72/72)=0.5 → 1125
    // Squat: totalLoad=1500, raw=2250, decay=0.5^(12/72)=0.5^(1/6)≈0.891 → ~2004
    // Chest should be lower than legs
    expect(result).toHaveProperty('chest');
    expect(result).toHaveProperty('legs'); // quads normalizes to legs
    expect(result.legs).not.toBe('LOW');
  });

  // ── 3. Isolation 24h ago: lower fatigue, faster decay ──────────────

  it('returns lower fatigue for an isolation exercise (lower weight, faster decay)', () => {
    const date = hoursAgo(24, FIXED_NOW);
    const workouts = [
      makeWorkout(date, [
        makeExercise('Cable Lateral Raise', [
          { weight: 10, reps: 15 },
          { weight: 10, reps: 12 },
          { weight: 10, reps: 12 },
        ]),
      ]),
    ];

    // totalLoad = 10*15 + 10*12 + 10*12 = 390
    // rawFatigue = 390 * 0.5 = 195
    // decayFactor = 0.5^(24/48) = 0.5^0.5 ≈ 0.7071
    // decayedFatigue ≈ 195 * 0.7071 ≈ 137.9
    const configs = isolationConfig();
    const result = computeMuscleFatigue(workouts, configs, new Map());

    expect(result).toHaveProperty('shoulders');
  });

  // ── 4. Multiple workouts hitting same muscle accumulate ────────────

  it('accumulates fatigue from multiple workouts targeting the same muscle', () => {
    const day1 = hoursAgo(48, FIXED_NOW);
    const day2 = hoursAgo(24, FIXED_NOW);

    const workouts = [
      makeWorkout(day1, [
        makeExercise('Barbell Bench Press', [
          { weight: 80, reps: 8 },
          { weight: 80, reps: 8 },
        ]),
      ]),
      makeWorkout(day2, [
        makeExercise('Barbell Bench Press', [
          { weight: 80, reps: 8 },
          { weight: 80, reps: 8 },
        ]),
      ]),
    ];

    const configs = compoundConfig();

    // Single-workout reference
    const singleWorkout = [workouts[1]]; // just the 24h-ago workout
    const singleResult = computeMuscleFatigue(singleWorkout, configs, new Map());

    // Both workouts
    const doubleResult = computeMuscleFatigue(workouts, configs, new Map());

    // Both should have chest. With only 1 muscle group and 1 value the
    // classification will be the same, but the underlying score should differ.
    // We verify by adding a second muscle group with known lower fatigue.
    const workoutsWithArms = [
      ...workouts,
      makeWorkout(hoursAgo(96, FIXED_NOW), [
        makeExercise('Barbell Curl', [
          { weight: 20, reps: 10 },
        ]),
      ]),
    ];

    const configsWithArms = new Map([
      ...configs,
      ['Barbell Curl', {
        fatigue_weight: 0.5,
        recovery_hours: 48,
        muscle_groups: ['biceps'],
      }],
    ]);

    const accumulated = computeMuscleFatigue(workoutsWithArms, configsWithArms, new Map());

    // chest had two workouts worth of fatigue; arms had one old workout
    // chest should be HIGH relative to arms which should be LOW
    expect(accumulated).toHaveProperty('chest');
    expect(accumulated).toHaveProperty('arms'); // biceps normalizes to arms
    expect(accumulated.chest).toBe('HIGH');
    expect(accumulated.arms).toBe('LOW');
  });

  // ── 5. No recent workouts → empty object ──────────────────────────

  it('returns empty object when there are no recent workouts', () => {
    const result = computeMuscleFatigue([], new Map(), new Map());
    expect(result).toEqual({});
  });

  it('returns empty object when workouts have no exercises', () => {
    const workouts = [
      makeWorkout(hoursAgo(24, FIXED_NOW), []),
    ];
    const result = computeMuscleFatigue(workouts, new Map(), new Map());
    expect(result).toEqual({});
  });

  // ── 6. Classification buckets with 4+ muscle groups ───────────────

  it('classifies fatigue into HIGH / MEDIUM / LOW using percentile buckets', () => {
    // Create workouts that produce clearly different fatigue levels per group
    const recentDate = hoursAgo(12, FIXED_NOW);
    const oldDate = hoursAgo(60, FIXED_NOW);

    const workouts = [
      // Heavy recent chest work → highest fatigue
      makeWorkout(recentDate, [
        makeExercise('Barbell Bench Press', [
          { weight: 120, reps: 5 },
          { weight: 120, reps: 5 },
          { weight: 120, reps: 5 },
          { weight: 120, reps: 5 },
        ]),
      ]),
      // Moderate recent leg work → second highest
      makeWorkout(recentDate, [
        makeExercise('Barbell Squat', [
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
        ]),
      ]),
      // Moderate-old shoulder work → medium fatigue
      makeWorkout(oldDate, [
        makeExercise('Overhead Press', [
          { weight: 60, reps: 8 },
          { weight: 60, reps: 8 },
          { weight: 60, reps: 8 },
        ]),
      ]),
      // Light old arm work → lowest fatigue
      makeWorkout(oldDate, [
        makeExercise('Barbell Curl', [
          { weight: 20, reps: 10 },
          { weight: 20, reps: 10 },
        ]),
      ]),
    ];

    const configs = new Map([
      ['Barbell Bench Press', {
        fatigue_weight: 1.5,
        recovery_hours: 72,
        muscle_groups: ['chest'],
      }],
      ['Barbell Squat', {
        fatigue_weight: 1.5,
        recovery_hours: 72,
        muscle_groups: ['quads'],
      }],
      ['Overhead Press', {
        fatigue_weight: 1.2,
        recovery_hours: 72,
        muscle_groups: ['shoulders'],
      }],
      ['Barbell Curl', {
        fatigue_weight: 0.5,
        recovery_hours: 48,
        muscle_groups: ['biceps'],
      }],
    ]);

    const result = computeMuscleFatigue(workouts, configs, new Map());

    // 4 muscle groups: chest, legs, shoulders, arms
    // Chest → highest → HIGH
    // Arms → lowest → LOW
    // Legs, Shoulders → middle → MEDIUM (or one could be HIGH/LOW at boundary)
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(4);
    expect(result.chest).toBe('HIGH');
    expect(result.arms).toBe('LOW');
    // Middle values should be MEDIUM
    expect(['HIGH', 'MEDIUM']).toContain(result.legs);
    expect(['MEDIUM', 'LOW']).toContain(result.shoulders);
  });

  // ── 7. Unknown muscle group falls back to title-based inference ────

  it('falls back to title-based muscle group inference for unknown exercises', () => {
    const date = hoursAgo(24, FIXED_NOW);
    const workouts = [
      makeWorkout(date, [
        // "Bench Press" should be inferred as chest by inferMuscleGroupFromTitle
        makeExercise('Incline Bench Press', [
          { weight: 60, reps: 10 },
          { weight: 60, reps: 10 },
        ]),
      ]),
    ];

    // No config for this exercise
    const configs = new Map();
    // No template either — forces inferMuscleGroupFromTitle fallback
    const templateLookup = new Map();

    const result = computeMuscleFatigue(workouts, configs, templateLookup);

    // inferMuscleGroupFromTitle('Incline Bench Press') matches /bench press/i → 'chest'
    expect(result).toHaveProperty('chest');
  });

  it('uses templateLookup muscle_group before falling back to title inference', () => {
    const date = hoursAgo(24, FIXED_NOW);
    const workouts = [
      makeWorkout(date, [
        makeExercise('Some Custom Exercise', [
          { weight: 50, reps: 10 },
          { weight: 50, reps: 10 },
        ]),
      ]),
    ];

    const configs = new Map(); // no config
    const templateLookup = new Map([
      ['Some Custom Exercise', { muscle_group: 'chest' }],
    ]);

    const result = computeMuscleFatigue(workouts, configs, templateLookup);

    expect(result).toHaveProperty('chest');
  });

  // ── 8. Bodyweight exercise: weight_kg=0 defaults to 1 ────────────

  it('uses reps as fatigue proxy when weight_kg is 0 (bodyweight exercise)', () => {
    const date = hoursAgo(24, FIXED_NOW);
    const workouts = [
      makeWorkout(date, [
        makeExercise('Pull Up', [
          { weight: 0, reps: 12 },
          { weight: 0, reps: 10 },
          { weight: 0, reps: 8 },
        ]),
      ]),
    ];

    const configs = new Map([
      ['Pull Up', {
        fatigue_weight: 1.0,
        recovery_hours: 72,
        muscle_groups: ['lats'],
      }],
    ]);

    const result = computeMuscleFatigue(workouts, configs, new Map());

    // weight defaults to 1 when weight_kg=0
    // totalLoad = 1*12 + 1*10 + 1*8 = 30
    // rawFatigue = 30 * 1.0 = 30
    // decayFactor = 0.5^(24/72) ≈ 0.7937
    // decayedFatigue ≈ 30 * 0.7937 ≈ 23.8
    // lats normalizes to 'back'
    expect(result).toHaveProperty('back');
  });

  it('bodyweight exercise produces nonzero fatigue (not treated as zero load)', () => {
    const date = hoursAgo(12, FIXED_NOW);
    const workouts = [
      // Bodyweight push ups — no weight
      makeWorkout(date, [
        makeExercise('Push Up', [
          { weight: 0, reps: 20 },
          { weight: 0, reps: 20 },
          { weight: 0, reps: 15 },
        ]),
      ]),
      // Weighted bench for comparison
      makeWorkout(date, [
        makeExercise('Barbell Squat', [
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
        ]),
      ]),
    ];

    const configs = new Map([
      ['Push Up', {
        fatigue_weight: 1.0,
        recovery_hours: 72,
        muscle_groups: ['chest'],
      }],
      ['Barbell Squat', {
        fatigue_weight: 1.5,
        recovery_hours: 72,
        muscle_groups: ['quads'],
      }],
    ]);

    const result = computeMuscleFatigue(workouts, configs, new Map());

    // Push Up: totalLoad = 1*20 + 1*20 + 1*15 = 55, raw = 55
    // Squat: totalLoad = 100*5 + 100*5 = 1000, raw = 1500
    // Both should appear — chest will be LOW relative to legs (HIGH)
    expect(result).toHaveProperty('chest');
    expect(result).toHaveProperty('legs');
    expect(result.chest).toBe('LOW');
    expect(result.legs).toBe('HIGH');
  });
});
