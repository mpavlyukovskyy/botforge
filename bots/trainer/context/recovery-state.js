/**
 * Context builder: recovery_state
 *
 * Injects 1-2 line readiness summary.
 */
import { ensureDb, getRecoveryForDate } from '../lib/db.js';

export default {
  type: 'recovery_state',
  async build(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return '';
    }

    const today = new Date().toISOString().slice(0, 10);
    const recovery = getRecoveryForDate(ctx.config, today);

    if (!recovery) {
      return '<recovery_state>No recovery data for today.</recovery_state>';
    }

    const parts = [];

    if (recovery.combined_readiness) {
      parts.push(`readiness: ${recovery.combined_readiness}`);
    }

    if (recovery.whoop_recovery_score != null) {
      parts.push(`whoop: ${recovery.whoop_recovery_score}%`);
    }

    if (recovery.whoop_hrv != null) {
      parts.push(`hrv: ${Math.round(recovery.whoop_hrv)}ms`);
    }

    if (recovery.eightsleep_sleep_score != null) {
      parts.push(`8sleep: ${recovery.eightsleep_sleep_score}`);
    }

    if (parts.length === 0) return '';
    return `<recovery_state>${parts.join(', ')}</recovery_state>`;
  },
};
