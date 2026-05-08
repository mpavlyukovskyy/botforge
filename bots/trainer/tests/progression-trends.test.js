import { describe, it, expect } from 'vitest';
import { computeProgressionSlope, computeProgramProgressions } from '../lib/workout-analyzer.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a performances array from a list of weights.
 * Each entry gets a sequential date (one week apart) and a fixed rep count.
 */
function makePerformances(weights, { startDate = '2025-01-06', reps = 8 } = {}) {
  return weights.map((weight, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i * 7);
    return { date: d.toISOString().slice(0, 10), weight, reps };
  });
}

// ─── computeProgressionSlope ────────────────────────────────────────────────

describe('computeProgressionSlope', () => {
  it('detects linear increase as progressing with positive slope', () => {
    const perfs = makePerformances([80, 82.5, 85, 87.5]);
    const result = computeProgressionSlope('Bench Press', perfs);

    expect(result.exercise).toBe('Bench Press');
    expect(result.data_points).toBe(4);
    expect(result.trend).toBe('progressing');
    expect(result.slope).toBeGreaterThan(2);
  });

  it('detects flat weights as stable with slope near zero', () => {
    const perfs = makePerformances([80, 80, 80, 80]);
    const result = computeProgressionSlope('Squat', perfs);

    expect(result.trend).toBe('stable');
    expect(result.slope).toBeCloseTo(0, 1);
  });

  it('detects declining weights as regressing with negative slope', () => {
    const perfs = makePerformances([90, 87.5, 85, 82.5]);
    const result = computeProgressionSlope('Overhead Press', perfs);

    expect(result.trend).toBe('regressing');
    expect(result.slope).toBeLessThan(-2);
  });

  it('treats oscillating weights as stable (regression slope near zero)', () => {
    const perfs = makePerformances([80, 85, 80, 85, 80]);
    const result = computeProgressionSlope('Barbell Row', perfs);

    expect(result.trend).toBe('stable');
    // The linear regression slope of [80,85,80,85,80] is near zero
    expect(Math.abs(result.slope)).toBeLessThan(2);
  });

  it('returns insufficient trend when fewer than 4 data points', () => {
    const perfs = makePerformances([80, 82.5]);
    const result = computeProgressionSlope('Deadlift', perfs);

    expect(result.trend).toBe('insufficient');
    expect(result.data_points).toBe(2);
    expect(result.slope).toBe(0);
  });

  it('returns stable with slope 0 when all weights are identical', () => {
    const perfs = makePerformances([60, 60, 60, 60, 60]);
    const result = computeProgressionSlope('Lat Pulldown', perfs);

    expect(result.trend).toBe('stable');
    expect(result.slope).toBe(0);
  });

  it('handles a single outlier without flipping the overall trend', () => {
    // [80, 80, 50, 80, 80] — the dip at index 2 should not dominate
    const perfs = makePerformances([80, 80, 50, 80, 80]);
    const result = computeProgressionSlope('Cable Row', perfs);

    // Linear regression over [80,80,50,80,80] yields a small slope;
    // the function should report stable (slope pct between -2 and 2)
    expect(result.trend).toBe('stable');
  });
});

// ─── computeProgramProgressions ─────────────────────────────────────────────

describe('computeProgramProgressions', () => {
  /**
   * Build minimal Hevy-style workout objects that computeProgramProgressions
   * can consume via getPerformancesForExercise internally.
   */
  function buildWorkouts(exerciseData) {
    // exerciseData: { [exerciseName]: number[] (weights) }
    // Returns sorted workout objects, one per date, each containing one exercise.
    const workouts = [];
    for (const [name, weights] of Object.entries(exerciseData)) {
      weights.forEach((weight, i) => {
        const d = new Date('2025-01-06');
        d.setDate(d.getDate() + i * 7);
        workouts.push({
          start_time: d.toISOString(),
          exercises: [
            {
              title: name,
              sets: [{ type: 'normal', weight_kg: weight, reps: 8 }],
            },
          ],
        });
      });
    }
    // Sort ascending by date
    workouts.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    return workouts;
  }

  it('returns progression results for each requested exercise', () => {
    const workouts = buildWorkouts({
      'Bench Press': [80, 82.5, 85, 87.5],
      'Squat': [100, 100, 100, 100],
      'Deadlift': [120, 125],
    });

    const results = computeProgramProgressions(workouts, [
      'Bench Press',
      'Squat',
      'Deadlift',
    ]);

    expect(results).toHaveLength(3);

    const bench = results.find(r => r.exercise === 'Bench Press');
    expect(bench.trend).toBe('progressing');

    const squat = results.find(r => r.exercise === 'Squat');
    expect(squat.trend).toBe('stable');

    const deadlift = results.find(r => r.exercise === 'Deadlift');
    expect(deadlift.trend).toBe('insufficient');
  });

  it('returns an empty array when given no exercise names', () => {
    const workouts = buildWorkouts({ 'Bench Press': [80, 82.5, 85, 87.5] });
    const results = computeProgramProgressions(workouts, []);

    expect(results).toEqual([]);
  });

  it('returns insufficient for exercises not found in workouts', () => {
    const workouts = buildWorkouts({ 'Bench Press': [80, 82.5, 85, 87.5] });
    const results = computeProgramProgressions(workouts, ['Non-Existent Lift']);

    expect(results).toHaveLength(1);
    expect(results[0].exercise).toBe('Non-Existent Lift');
    expect(results[0].trend).toBe('insufficient');
    expect(results[0].data_points).toBe(0);
  });
});
