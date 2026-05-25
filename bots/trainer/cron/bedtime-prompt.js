/**
 * Cron: bedtime_prompt (T-15m — shower signal)
 *
 * Fires at 1:00am ET. Calls the shared sendWindDownPhase('shower') helper.
 * The helper handles: override read, idempotency, alreadyAsleep skip, target
 * cache, message rendering. v1 message text preserved.
 *
 * Refactored 2026-05-24 from the standalone v1. v2 architecture moves all
 * logic into `lib/bedtime-helper.js` so the three wind-down phases share code.
 */
import { computeHrvDrift } from '../lib/deload-detector.js';
import { getRecoveryRange } from '../lib/db.js';
import { sendWindDownPhase, getLastNightContext } from '../lib/bedtime-helper.js';

export default {
  name: 'bedtime_prompt',
  async execute(ctx) {
    const { lastNightSleepMin, lastNightRecovery, source } = await getLastNightContext(ctx.config, ctx.log);
    ctx.log?.info?.(`bedtime_prompt: recovery source=${source} sleep=${lastNightSleepMin} recovery=${lastNightRecovery}`);

    // Pull 30 days for HRV drift
    let hrvDeltaPct = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const start30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const history = getRecoveryRange(ctx.config, start30, today);
      hrvDeltaPct = computeHrvDrift(history).deltaPct;
    } catch (err) {
      ctx.log?.debug?.(`bedtime_prompt: HRV drift unavailable (${err.message})`);
    }

    await sendWindDownPhase(ctx, 'shower', {
      lastNightSleepMin,
      lastNightRecovery,
      hrvDeltaPct,
    });
  },
};
