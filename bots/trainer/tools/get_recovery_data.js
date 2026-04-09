/**
 * Brain tool: get_recovery_data
 *
 * Returns today's recovery data from Whoop + Eight Sleep cache.
 */
import { z } from 'zod';
import { ensureDb, getRecoveryForDate } from '../lib/db.js';

export default {
  name: 'get_recovery_data',
  description: "Get today's recovery data (Whoop recovery score, HRV, RHR, strain, Eight Sleep sleep score). Data comes from the daily sync cache.",
  schema: {
    date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const date = args.date || new Date().toISOString().slice(0, 10);
    const recovery = getRecoveryForDate(ctx.config, date);

    if (!recovery) {
      return `No recovery data for ${date}. The daily sync may not have run yet (runs at 5am ET).`;
    }

    const lines = [];
    lines.push(`Recovery data for ${date}:`);
    lines.push(`Combined readiness: ${recovery.combined_readiness || 'unknown'}`);
    lines.push('');

    if (recovery.whoop_recovery_score != null) {
      lines.push('Whoop:');
      lines.push(`  Recovery: ${recovery.whoop_recovery_score}%`);
      if (recovery.whoop_hrv != null) lines.push(`  HRV: ${Math.round(recovery.whoop_hrv)}ms`);
      if (recovery.whoop_rhr != null) lines.push(`  RHR: ${Math.round(recovery.whoop_rhr)}bpm`);
      if (recovery.whoop_strain != null) lines.push(`  Yesterday's strain: ${recovery.whoop_strain.toFixed(1)}`);
      if (recovery.whoop_sleep_performance != null) lines.push(`  Sleep performance: ${recovery.whoop_sleep_performance}%`);
    } else {
      lines.push('Whoop: no data');
    }

    lines.push('');

    if (recovery.eightsleep_sleep_score != null) {
      lines.push('Eight Sleep:');
      lines.push(`  Sleep score: ${recovery.eightsleep_sleep_score}`);
      if (recovery.eightsleep_hrv != null) lines.push(`  HRV: ${Math.round(recovery.eightsleep_hrv)}ms`);
      if (recovery.eightsleep_deep_sleep_min != null) lines.push(`  Deep sleep: ${recovery.eightsleep_deep_sleep_min}min`);
      if (recovery.eightsleep_total_sleep_min != null) lines.push(`  Total sleep: ${recovery.eightsleep_total_sleep_min}min`);
    } else {
      lines.push('Eight Sleep: no data');
    }

    return lines.join('\n');
  },
};
