/**
 * Reactive deload detection — multi-signal composite score.
 *
 * Signals: RPE overshoot, exercise stalls, declining recovery, joint pain, fatigue escalation.
 * Threshold adjusts based on mesocycle position (later weeks expect more fatigue).
 * Graduated response: soft deload (20-30% reduction) vs full deload (50%).
 */

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
