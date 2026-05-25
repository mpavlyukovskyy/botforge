/**
 * Reactive deload detection — multi-signal composite score.
 *
 * Signals: RPE overshoot, exercise stalls, declining recovery, joint pain,
 * fatigue escalation, HRV drift (post-2026-05-24 holistic-analysis finding).
 *
 * Threshold adjusts based on mesocycle position (later weeks expect more fatigue).
 * Graduated response: soft deload (20-30% reduction) vs full deload (50%).
 *
 * Anti-patterns explicitly rejected (do NOT re-add):
 *  - Strain → next-day recovery: confounded by reverse causation (high strain
 *    only happens on already-fresh days). r=+0.018 in Mark's 142-day data.
 *  - Streak length as fatigue signal: self-selected (Mark starts streaks when
 *    he feels good); recovery RISES through streaks (regression to mean).
 */

/**
 * Compute a 7-day rolling HRV and its delta vs a 30-day baseline.
 *
 * @param {Array} recoveryRows - recovery_daily rows sorted by date ASC, must include whoop_hrv
 * @returns {{avg7d: number|null, baseline30d: number|null, deltaPct: number|null}}
 */
export function computeHrvDrift(recoveryRows) {
  if (!Array.isArray(recoveryRows) || recoveryRows.length === 0) {
    return { avg7d: null, baseline30d: null, deltaPct: null };
  }

  const valid = recoveryRows.filter((r) => r.whoop_hrv != null && r.whoop_hrv > 0);
  if (valid.length === 0) return { avg7d: null, baseline30d: null, deltaPct: null };

  const sorted = valid.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const last7 = sorted.slice(-7);
  const last30 = sorted.slice(-30);

  const avg = (rows) => rows.reduce((s, r) => s + r.whoop_hrv, 0) / rows.length;
  const avg7d = last7.length > 0 ? avg(last7) : null;
  const baseline30d = last30.length >= 14 ? avg(last30) : null;

  let deltaPct = null;
  if (avg7d != null && baseline30d != null && baseline30d > 0) {
    deltaPct = ((avg7d - baseline30d) / baseline30d) * 100;
  }

  return {
    avg7d: avg7d != null ? Math.round(avg7d) : null,
    baseline30d: baseline30d != null ? Math.round(baseline30d) : null,
    deltaPct: deltaPct != null ? Math.round(deltaPct * 10) / 10 : null,
  };
}

/**
 * Compute a deload score from multiple fatigue signals.
 *
 * @param {object} data
 * @param {Array} data.feedbackHistory - Recent workout_feedback rows (newest first)
 * @param {Array} data.progressionStates - exercise_progression rows for current program
 * @param {string} data.recoveryTrend - 'improving' | 'stable' | 'declining'
 * @param {number} data.currentWeek - Current week in the mesocycle
 * @param {number} data.totalWeeks - Total weeks in the mesocycle
 * @returns {{ score: number, threshold: number, triggered: boolean, severity: string|null }}
 */
export function computeDeloadScore(data) {
  const {
    feedbackHistory = [],
    progressionStates = [],
    recoveryTrend = 'stable',
    currentWeek = 1,
    totalWeeks = 6,
  } = data;

  let score = 0;

  // Signal 1: RPE overshoot (feedback shows harder_than_prescribed)
  const recentFeedback = feedbackHistory.slice(0, 5);
  const harderCount = recentFeedback.filter(f => f.rpe_accuracy === 'harder_than_prescribed').length;
  if (harderCount >= 3) score += 30;
  else if (harderCount >= 2) score += 15;

  // Signal 2: Multiple exercises stalling
  const totalExercises = progressionStates.length;
  if (totalExercises > 0) {
    const stalledCount = progressionStates.filter(p => p.status === 'stalled').length;
    if (stalledCount >= totalExercises * 0.5) score += 25;
    else if (stalledCount >= totalExercises * 0.3) score += 10;
  }

  // Signal 3: Recovery trending down
  if (recoveryTrend === 'declining') score += 20;

  // Signal 4: Joint pain reported
  const painCount = recentFeedback.filter(f => f.joint_pain === 'significant').length;
  if (painCount >= 2) score += 25;
  else if (painCount >= 1) score += 10;

  // Signal 5: Fatigue ratings escalating
  const fatiguedCount = recentFeedback.filter(
    f => f.fatigue_level === 'fatigued' || f.fatigue_level === 'exhausted'
  ).length;
  if (fatiguedCount >= 3) score += 20;

  // Signal 6: HRV drift vs 30-day baseline (post-2026-05-24 finding).
  // Mark's HRV dropped 9% Jan→May; mild cumulative fatigue marker.
  // ≤ -10% adds 20pt, ≤ -5% adds 10pt.
  const hrvDeltaPct = data.hrvDeltaPct;
  if (typeof hrvDeltaPct === 'number') {
    if (hrvDeltaPct <= -10) score += 20;
    else if (hrvDeltaPct <= -5) score += 10;
  }

  // Adjust threshold based on mesocycle position
  const weekProgress = totalWeeks > 0 ? currentWeek / totalWeeks : 0;
  const threshold = weekProgress > 0.6 ? 80 : weekProgress > 0.3 ? 65 : 60;

  const triggered = score >= threshold;
  const severity = triggered
    ? (score >= threshold + 20 ? 'full' : 'soft')
    : null;

  return { score, threshold, triggered, severity };
}

/**
 * Determine recovery trend from recent recovery data.
 *
 * @param {Array} recoveryRows - recovery_daily rows sorted by date ASC
 * @returns {'improving' | 'stable' | 'declining'}
 */
export function computeRecoveryTrend(recoveryRows) {
  const scores = recoveryRows
    .filter(r => r.whoop_recovery_score != null)
    .map(r => r.whoop_recovery_score);

  if (scores.length < 4) return 'stable';

  const mid = Math.floor(scores.length / 2);
  const firstHalf = scores.slice(0, mid);
  const secondHalf = scores.slice(mid);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const change = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;

  if (change > 10) return 'improving';
  if (change < -10) return 'declining';
  return 'stable';
}
