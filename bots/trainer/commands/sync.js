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
      ensureDb(ctx.config);
      const today = new Date().toISOString().slice(0, 10);
      const recovery = getRecoveryForDate(ctx.config, today);
      const readiness = recovery?.combined_readiness || 'unknown';
      const parts = [];
      if (recovery?.whoop_recovery_score != null) parts.push(`Whoop ${recovery.whoop_recovery_score}%`);
      if (recovery?.whoop_hrv != null) parts.push(`HRV ${Math.round(recovery.whoop_hrv)}ms`);
      if (recovery?.eightsleep_sleep_score != null) parts.push(`8Sleep ${recovery.eightsleep_sleep_score}`);
      const summary = parts.length > 0 ? parts.join(' | ') : 'No data returned';
      const templateCount = getAllExerciseTemplates(ctx.config).length;
      await ctx.adapter.send({
        chatId,
        text: `Sync complete. Readiness: ${readiness}\n${summary}\nHevy templates: ${templateCount}`,
      });
    } catch (err) {
      lastSyncByChat.delete(chatId);
      await ctx.adapter.send({ chatId, text: `Sync failed: ${err.message}` });
    }
  },
};
