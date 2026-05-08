import { describe, it, expect } from 'vitest';
import { computeDeloadScore, computeRecoveryTrend } from '../lib/deload-detector.js';

describe('computeDeloadScore', () => {
  it('returns score=0 and triggered=false when no signals are present', () => {
    const result = computeDeloadScore({
      feedbackHistory: [],
      progressionStates: [],
      recoveryTrend: 'stable',
      currentWeek: 1,
      totalWeeks: 6,
    });
    expect(result.score).toBe(0);
    expect(result.triggered).toBe(false);
    expect(result.severity).toBeNull();
  });

  it('scores +30 for RPE overshoot with 3 consecutive harder_than_prescribed', () => {
    const feedbackHistory = [
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
    ];
    const result = computeDeloadScore({
      feedbackHistory,
      progressionStates: [],
      recoveryTrend: 'stable',
      currentWeek: 1,
      totalWeeks: 6,
    });
    expect(result.score).toBe(30);
    // week 1/6 → weekProgress ~0.167 → threshold 60
    expect(result.threshold).toBe(60);
    expect(result.triggered).toBe(false);
  });

  it('triggers deload when multiple signals combine to exceed early-week threshold', () => {
    // RPE overshoot (3 harder) = +30
    // 50%+ stalled = +25
    // declining recovery = +20
    // total = 75, threshold at week 1/6 = 60 → triggered
    const feedbackHistory = [
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
    ];
    const progressionStates = [
      { status: 'stalled' },
      { status: 'stalled' },
      { status: 'progressing' },
      { status: 'stalled' },
    ];
    const result = computeDeloadScore({
      feedbackHistory,
      progressionStates,
      recoveryTrend: 'declining',
      currentWeek: 1,
      totalWeeks: 6,
    });
    expect(result.score).toBe(75);
    expect(result.threshold).toBe(60);
    expect(result.triggered).toBe(true);
  });

  it('does NOT trigger at late mesocycle due to higher threshold', () => {
    // Same score of 75, but week 5/6 → weekProgress ~0.833 → threshold 80
    const feedbackHistory = [
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
    ];
    const progressionStates = [
      { status: 'stalled' },
      { status: 'stalled' },
      { status: 'progressing' },
      { status: 'stalled' },
    ];
    const result = computeDeloadScore({
      feedbackHistory,
      progressionStates,
      recoveryTrend: 'declining',
      currentWeek: 5,
      totalWeeks: 6,
    });
    expect(result.score).toBe(75);
    expect(result.threshold).toBe(80);
    expect(result.triggered).toBe(false);
    expect(result.severity).toBeNull();
  });

  it('returns severity=full when score exceeds threshold+20', () => {
    // RPE(30) + stalls(25) + declining(20) + pain(25) + fatigue(20) = 120
    // threshold=60 at week 1/6, score >= 80 → severity='full'
    const feedbackHistory = [
      { rpe_accuracy: 'harder_than_prescribed', joint_pain: 'significant', fatigue_level: 'exhausted' },
      { rpe_accuracy: 'harder_than_prescribed', joint_pain: 'significant', fatigue_level: 'fatigued' },
      { rpe_accuracy: 'harder_than_prescribed', fatigue_level: 'fatigued' },
    ];
    const progressionStates = [
      { status: 'stalled' },
      { status: 'stalled' },
      { status: 'stalled' },
    ];
    const result = computeDeloadScore({
      feedbackHistory,
      progressionStates,
      recoveryTrend: 'declining',
      currentWeek: 1,
      totalWeeks: 6,
    });
    expect(result.score).toBe(120);
    expect(result.threshold).toBe(60);
    expect(result.triggered).toBe(true);
    expect(result.severity).toBe('full');
  });

  it('returns severity=soft when score meets threshold but not threshold+20', () => {
    // RPE(30) + stalls(25) + pain x1(10) = 65
    // threshold=60 at week 1/6, 65 >= 60 but 65 < 80 → severity='soft'
    const feedbackHistory = [
      { rpe_accuracy: 'harder_than_prescribed', joint_pain: 'significant' },
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
    ];
    const progressionStates = [
      { status: 'stalled' },
      { status: 'stalled' },
      { status: 'progressing' },
    ];
    const result = computeDeloadScore({
      feedbackHistory,
      progressionStates,
      recoveryTrend: 'stable',
      currentWeek: 1,
      totalWeeks: 6,
    });
    expect(result.score).toBe(65);
    expect(result.threshold).toBe(60);
    expect(result.triggered).toBe(true);
    expect(result.severity).toBe('soft');
  });

  it('adds +25 for 2 significant joint pain reports', () => {
    const feedbackHistory = [
      { joint_pain: 'significant' },
      { joint_pain: 'significant' },
      { joint_pain: 'none' },
    ];
    const result = computeDeloadScore({
      feedbackHistory,
      progressionStates: [],
      recoveryTrend: 'stable',
      currentWeek: 1,
      totalWeeks: 6,
    });
    expect(result.score).toBe(25);
  });

  it('returns score=0 for empty feedback history', () => {
    const result = computeDeloadScore({
      feedbackHistory: [],
      progressionStates: [
        { status: 'progressing' },
        { status: 'progressing' },
      ],
      recoveryTrend: 'stable',
      currentWeek: 3,
      totalWeeks: 6,
    });
    expect(result.score).toBe(0);
  });

  it('returns stall score=0 when progressionStates is empty', () => {
    const feedbackHistory = [
      { rpe_accuracy: 'harder_than_prescribed' },
      { rpe_accuracy: 'harder_than_prescribed' },
    ];
    const result = computeDeloadScore({
      feedbackHistory,
      progressionStates: [],
      recoveryTrend: 'stable',
      currentWeek: 2,
      totalWeeks: 6,
    });
    // Only RPE with 2 harder → +15, no stall contribution
    expect(result.score).toBe(15);
  });
});

describe('computeRecoveryTrend', () => {
  it('returns declining for decreasing recovery scores', () => {
    const rows = [
      { whoop_recovery_score: 80 },
      { whoop_recovery_score: 70 },
      { whoop_recovery_score: 60 },
      { whoop_recovery_score: 50 },
    ];
    expect(computeRecoveryTrend(rows)).toBe('declining');
  });

  it('returns improving for increasing recovery scores', () => {
    const rows = [
      { whoop_recovery_score: 50 },
      { whoop_recovery_score: 60 },
      { whoop_recovery_score: 70 },
      { whoop_recovery_score: 80 },
    ];
    expect(computeRecoveryTrend(rows)).toBe('improving');
  });

  it('returns stable for flat recovery scores', () => {
    const rows = [
      { whoop_recovery_score: 70 },
      { whoop_recovery_score: 70 },
      { whoop_recovery_score: 70 },
      { whoop_recovery_score: 70 },
    ];
    expect(computeRecoveryTrend(rows)).toBe('stable');
  });

  it('returns stable when fewer than 4 data points', () => {
    const rows = [
      { whoop_recovery_score: 80 },
      { whoop_recovery_score: 40 },
    ];
    expect(computeRecoveryTrend(rows)).toBe('stable');
  });
});
