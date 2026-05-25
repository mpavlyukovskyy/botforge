/**
 * Cron: whoop_recovery_refresh_midday — fires at 12:30pm ET.
 *
 * Primary fetch of today's recovery, scheduled after Mark's typical 11am+
 * wake-up + Whoop's ~30min post-wake compute delay.
 */
import { todayEt } from '../lib/bedtime-helper.js';
import { fetchAndStoreTodayRecovery } from '../lib/recovery-fetch.js';

export default {
  name: 'whoop_recovery_refresh_midday',
  async execute(ctx) {
    const today = todayEt();
    const r = await fetchAndStoreTodayRecovery(ctx.config, today, ctx.log);
    if (r.fetched) ctx.log?.info?.(`whoop_recovery_refresh_midday: ${today} recovery=${r.recovery} sleep=${r.sleepMin}min`);
    else ctx.log?.info?.(`whoop_recovery_refresh_midday: no data yet for ${today} (${r.reason})`);
  },
};
