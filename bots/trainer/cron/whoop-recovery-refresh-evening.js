/**
 * Cron: whoop_recovery_refresh_evening — fires at 6:00pm ET.
 *
 * Safety-net fetch for edge cases where the midday refresh fired before
 * Whoop computed today's recovery (very late wake-up, ring on charger, etc).
 * Bedtime cron at 11:30pm also has a JIT fallback — this just keeps the row
 * fresh for any code that reads it ad-hoc earlier in the evening.
 */
import { todayEt } from '../lib/bedtime-helper.js';
import { fetchAndStoreTodayRecovery } from '../lib/recovery-fetch.js';

export default {
  name: 'whoop_recovery_refresh_evening',
  async execute(ctx) {
    const today = todayEt();
    const r = await fetchAndStoreTodayRecovery(ctx.config, today, ctx.log);
    if (r.fetched) ctx.log?.info?.(`whoop_recovery_refresh_evening: ${today} recovery=${r.recovery} sleep=${r.sleepMin}min`);
    else ctx.log?.info?.(`whoop_recovery_refresh_evening: no data yet for ${today} (${r.reason})`);
  },
};
