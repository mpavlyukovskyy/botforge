import dailySync from '../cron/daily-sync.js';

const SYNC_DEBOUNCE_MS = 30_000;
const lastSyncByChat = new Map();

export default {
  command: 'sync',
  description: 'Force sync recovery + workout data',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    const now = Date.now();
    const last = lastSyncByChat.get(chatId) || 0;

    if (now - last < SYNC_DEBOUNCE_MS) {
      const secondsLeft = Math.ceil((SYNC_DEBOUNCE_MS - (now - last)) / 1000);
      await ctx.adapter.send({
        chatId,
        text: `Just synced ${Math.round((now - last) / 1000)}s ago — try again in ${secondsLeft}s.`,
      });
      return;
    }
    lastSyncByChat.set(chatId, now);

    try {
      await dailySync.execute(ctx);
      const { ensureDb, getRecoveryForDate, getAllExerciseTemplates } = await import('../lib/db.js');
      const { whoopStatusLine } = await import('../lib/alert-state.js');
      ensureDb(ctx.config);
      const today = new Date().toISOString().slice(0, 10);
      const recovery = getRecoveryForDate(ctx.config, today);
      const readiness = recovery?.combined_readiness || 'unknown';

      // Per-source outcomes — never claim "complete" when a source is down.
      const whoopBanner = whoopStatusLine(ctx.config);
      const whoopLine = whoopBanner
        ? `Whoop: ${whoopBanner}`
        : recovery?.whoop_recovery_score != null
          ? `Whoop: ${recovery.whoop_recovery_score}%${recovery.whoop_hrv != null ? ` | HRV ${Math.round(recovery.whoop_hrv)}ms` : ''}`
          : 'Whoop: no data returned';
      const eightLine = recovery?.eightsleep_sleep_score != null
        ? `8Sleep: ${recovery.eightsleep_sleep_score}`
        : '8Sleep: no data';
      const templateCount = getAllExerciseTemplates(ctx.config).length;
      const header = whoopBanner ? 'Sync finished (Whoop degraded).' : 'Sync complete.';
      await ctx.adapter.send({
        chatId,
        text: `${header} Readiness: ${readiness}\n${whoopLine}\n${eightLine}\nHevy templates: ${templateCount}`,
      });
    } catch (err) {
      lastSyncByChat.delete(chatId);
      await ctx.adapter.send({ chatId, text: `Sync failed: ${err.message}` });
    }
  },
};
