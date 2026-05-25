/**
 * Lifecycle hook: start
 *
 * Runs DB migrations, verifies Hevy API connectivity, and stores chat_id/tz
 * in the instance store for cron handlers. NO onboarding, NO narrative emission,
 * NO conversational kickoff — see program-rollover cron for program design.
 *
 * Stripped 2026-05-23 per Mark's "stop talking to me" direction.
 */
import { runMigrations, getState } from '../lib/db.js';

export default {
  event: 'start',
  async execute(ctx) {
    runMigrations(ctx);
    ctx.log.info('Trainer DB migrations complete');

    // Restore Telegram polling offset from last shutdown
    const savedOffset = getState(ctx.config, 'telegram_polling_offset');
    if (savedOffset && ctx.adapter.setPollingOffset) {
      ctx.adapter.setPollingOffset(parseInt(savedOffset, 10));
      ctx.log.info(`Telegram polling offset restored: ${savedOffset}`);
    }

    // Verify Hevy API key is configured
    const hevyKey = process.env.HEVY_API_KEY;
    if (hevyKey) {
      try {
        const res = await fetch('https://api.hevyapp.com/v1/workouts/count', {
          headers: { 'api-key': hevyKey },
        });
        if (res.ok) {
          const data = await res.json();
          ctx.log.info(`Hevy API connected (${data.workout_count} workouts)`);
        } else {
          ctx.log.warn(`Hevy API health check failed: ${res.status}`);
        }
      } catch (err) {
        ctx.log.warn(`Hevy API unreachable: ${err.message}`);
      }
    } else {
      ctx.log.warn('HEVY_API_KEY not set — Hevy integration disabled');
    }

    // Store config in shared store for cron handlers
    ctx.store.set('timezone', process.env.TIMEZONE || 'America/New_York');
    ctx.store.set('chat_id', process.env.TRAINER_CHAT_ID || ctx.config.platform?.chat_ids?.[0]);

    ctx.log.info('Trainer started');
  },
};
