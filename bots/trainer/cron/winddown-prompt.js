/**
 * Cron: winddown_prompt (T-90m — screens-down signal)
 *
 * Fires at 11:30pm ET. Second phase of the wind-down chain.
 *
 * Evidence: Chang et al. 2015 — evening light exposure suppresses melatonin
 * and delays circadian phase. T-90m is when most sleep-hygiene guides
 * recommend reducing blue-light/bright-screen exposure.
 */
import { computeHrvDrift } from '../lib/deload-detector.js';
import { getRecoveryRange } from '../lib/db.js';
import { sendWindDownPhase, getLastNightContext } from '../lib/bedtime-helper.js';

export default {
  name: 'winddown_prompt',
  async execute(ctx) {
    const { lastNightSleepMin, lastNightRecovery, source } = await getLastNightContext(ctx.config, ctx.log);
    ctx.log?.info?.(`winddown_prompt: recovery source=${source} sleep=${lastNightSleepMin} recovery=${lastNightRecovery}`);

    let hrvDeltaPct = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const start30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      hrvDeltaPct = computeHrvDrift(getRecoveryRange(ctx.config, start30, today)).deltaPct;
    } catch (err) {
      ctx.log?.debug?.(`winddown_prompt: HRV drift unavailable (${err.message})`);
    }

    await sendWindDownPhase(ctx, 'screens', {
      lastNightSleepMin,
      lastNightRecovery,
      hrvDeltaPct,
    });
  },
};
