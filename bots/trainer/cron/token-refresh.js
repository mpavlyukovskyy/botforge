/**
 * Cron handler: token_refresh
 *
 * Every 5 minutes — checks Whoop token expiry and refreshes if needed.
 * Also polls Hevy workout events for real-time completion sync.
 * Sends Telegram alert on failure.
 */
import {
  getOAuthToken, ensureDb,
  getState, setState,
  upsertWorkoutCache, isWorkoutNotified, markWorkoutNotified,
  getFeedbackForDate,
} from '../lib/db.js';
import { refreshAccessToken } from '../lib/whoop-client.js';
import { getWorkoutEvents, parseWorkoutForCache } from '../lib/hevy-client.js';
// sendFeedbackPrompt removed 2026-05-23 — no post-workout questions.

export default {
  name: 'token_refresh',
  async execute(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return; // DB not ready
    }

    // ── Whoop token refresh ───────────────────────────────────────────────
    const token = getOAuthToken(ctx.config, 'whoop');
    if (token) {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = token.expires_at || 0;

      if (expiresAt <= now + 600) {
        if (!token.refresh_token) {
          ctx.log.error('Whoop token expiring and no refresh token available');
          await alertUser(ctx, 'Whoop token expiring with no refresh token. Re-run whoop-auth.js.');
        } else {
          try {
            await refreshAccessToken(ctx.config, token.refresh_token);
            ctx.log.info('Whoop token refreshed');
          } catch (err) {
            ctx.log.error(`Whoop token refresh failed: ${err.message}`);
            await alertUser(ctx, `Whoop token refresh failed: ${err.message}`);
          }
        }
      }
    }

    // ── Hevy workout event polling ────────────────────────────────────────
    if (!process.env.HEVY_API_KEY) return;

    try {
      const lastCheck = getState(ctx.config, 'last_events_since');
      const since = lastCheck || new Date(Date.now() - 86400000).toISOString();

      const pollTime = new Date().toISOString();
      let allEvents = [];
      let page = 1;

      // Fetch all pages of events
      while (true) {
        const data = await getWorkoutEvents(since, page, 10);
        if (!data.events?.length) break;
        allEvents.push(...data.events);
        if (data.page >= data.page_count) break;
        page++;
      }

      if (allEvents.length === 0) {
        setState(ctx.config, 'last_events_since', pollTime);
        return;
      }

      let synced = 0;
      for (const event of allEvents) {
        if (event.type !== 'updated' || !event.workout) continue;

        const cached = parseWorkoutForCache(event.workout);
        upsertWorkoutCache(ctx.config, cached);
        synced++;
        // Feedback prompt removed 2026-05-23 — token-refresh now just caches
        // workout events; no user-facing prompts.
      }

      setState(ctx.config, 'last_events_since', pollTime);
      if (synced > 0) ctx.log.info(`Event poll: ${synced} workout(s) synced`);
    } catch (err) {
      ctx.log.warn(`Event poll error: ${err.message}`);
    }

    // ── Persist polling offset (crash resilience) ───────────────────────
    if (ctx.adapter.getPollingOffset) {
      const offset = ctx.adapter.getPollingOffset();
      if (offset > 0) {
        setState(ctx.config, 'telegram_polling_offset', String(offset));
      }
    }
  },
};

async function alertUser(ctx, message) {
  const chatId = ctx.store?.get('chat_id')
    || ctx.config.platform?.chat_ids?.[0]
    || process.env.TRAINER_CHAT_ID;

  if (!chatId) return;

  try {
    await ctx.adapter.send({
      chatId,
      text: `\u26a0\ufe0f Trainer alert: ${message}`,
    });
  } catch {
    // Can't alert — just log
  }
}
