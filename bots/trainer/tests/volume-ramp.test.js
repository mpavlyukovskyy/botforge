import { describe, it, expect } from 'vitest';
import { applyVolumeRamp } from '../cron/morning-workout.js';

const config = {
  strategy: 'additive_ramp',
  sets_added_per_week: 1,
  deload_week: 4,
  deload_volume_pct: 50,
  rpe_start: 7,
  rpe_end: 9,
};

const baseExercise = {
  name: 'Bench',
  sets: 3,
  rep_range: '8-10',
  rpe_target: 7,
};

describe('applyVolumeRamp', () => {
  it('week 1 (MEV) — no change to sets or RPE', () => {
    const result = applyVolumeRamp(baseExercise, 1, 6, config);
    expect(result.sets).toBe(3);
    expect(result.rpe_target).toBe(7);
  });

  it('week 3 — adds 2 sets and slides RPE toward target', () => {
    const result = applyVolumeRamp(baseExercise, 3, 6, config);
    expect(result.sets).toBe(5);
    expect(result.rpe_target).toBeCloseTo(8, 0);
  });

  it('deload week 4 — halves volume and drops RPE to 5', () => {
    const result = applyVolumeRamp(baseExercise, 4, 6, config);
    expect(result.sets).toBe(2);
    expect(result.rpe_target).toBe(5);
  });

  it('post-deload week 5 — ramp resumes from training week 4', () => {
    const result = applyVolumeRamp(baseExercise, 5, 6, config);
    // currentWeek 5 > deload_week 4 → trainingWeek = 5 - 1 = 4
    // addedSets = (4 - 1) * 1 = 3, total sets = 3 + 3 = 6
    expect(result.sets).toBe(6);
  });

  it('strategy "none" — returns exercise unchanged', () => {
    const noneConfig = { ...config, strategy: 'none' };
    const result = applyVolumeRamp(baseExercise, 3, 6, noneConfig);
    expect(result.sets).toBe(baseExercise.sets);
    expect(result.rpe_target).toBe(baseExercise.rpe_target);
  });

  it('null volumeProgression — returns exercise unchanged', () => {
    const result = applyVolumeRamp(baseExercise, 3, 6, null);
    expect(result.sets).toBe(baseExercise.sets);
    expect(result.rpe_target).toBe(baseExercise.rpe_target);
  });

  it('deload never drops sets below 2', () => {
    const tinyExercise = { ...baseExercise, sets: 1 };
    const result = applyVolumeRamp(tinyExercise, 4, 6, config);
    expect(result.sets).toBeGreaterThanOrEqual(2);
    expect(result.rpe_target).toBe(5);
  });
});
