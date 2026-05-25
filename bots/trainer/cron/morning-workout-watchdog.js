/**
 * Dead-man's switch for the morning_workout cron.
 *
 * Fires at 7:15am ET (15 minutes after morning_workout is scheduled). Checks
 * the heartbeat (bot_state.morning_workout_last_success_at). If the heartbeat
 * is older than 30 minutes, the morning workout didn't run successfully and
 * we DM Mark so he knows the bot is silently broken.
 *
 * Debounced via bot_state.watchdog_last_alert_date so we don't spam multiple
 * alerts in the same day.
 */
import { ensureDb, getState, setState } from '../lib/db.js';

const HEARTBEAT_STALENESS_MS = 30 * 60 * 1000; // 30 minutes

export default {
  name: 'morning_workout_watchdog',
  async execute(ctx) {
    const chatId = ctx.store?.get('chat_id')
      || ctx.config.platform?.chat_ids?.[0]
      || process.env.TRAINER_CHAT_ID;
    if (!chatId) return;

    ensureDb(ctx.config);

    const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const lastAlert = getState(ctx.config, 'watchdog_last_alert_date');
    if (lastAlert === todayKey) return; // already alerted today

    const lastSuccessStr = getState(ctx.config, 'morning_workout_last_success_at');
    const now = Date.now();
    const lastSuccess = lastSuccessStr ? parseInt(lastSuccessStr, 10) : 0;

    if (!lastSuccess || (now - lastSuccess) > HEARTBEAT_STALENESS_MS) {
      const ageStr = lastSuccess
        ? `${Math.round((now - lastSuccess) / 60000)} min ago`
        : 'never';
      setState(ctx.config, 'watchdog_last_alert_date', todayKey);
      try {
        await ctx.adapter.send({
          chatId,
          text: `[ADMIN] Morning workout cron didn't fire this morning. Last success: ${ageStr}. Check 'journalctl -u botforge-trainer --since "06:55"' on acemagic.`,
        });
        ctx.log.warn(`Morning workout watchdog: heartbeat stale (${ageStr}) — alerted Mark`);
      } catch (err) {
        ctx.log.error(`Watchdog DM failed: ${err.message}`);
      }
    }
  },
};
