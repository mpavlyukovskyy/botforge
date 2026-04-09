/**
 * Lifecycle hook: start
 *
 * Runs DB migrations and verifies Hevy API connectivity.
 */
import {
  runMigrations, ensureDb,
  getOnboardingAnalysis, getActiveGoals, getActiveProgram,
  upsertOnboardingAnalysis,
} from '../lib/db.js';
import { runOnboardingAnalysis } from '../lib/onboarding.js';

export default {
  event: 'start',
  async execute(ctx) {
    runMigrations(ctx);
    ctx.log.info('Trainer DB migrations complete');

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

    // ── One-time onboarding analysis ─────────────────────────────────────
    // Capture locals for async use (ctx may not persist after execute returns)
    const config = ctx.config;
    const log = ctx.log;
    const adapter = ctx.adapter;
    const chatId = ctx.store.get('chat_id') || process.env.TRAINER_CHAT_ID;

    const analysis = getOnboardingAnalysis(config);
    const goals = getActiveGoals(config);
    const program = getActiveProgram(config);

    if (!analysis && goals.length === 0 && !program && chatId) {
      log.info('Onboarding: starting full workout history analysis...');
      runOnboardingAnalysis(config, log, adapter, chatId).catch(err => {
        log.error(`Onboarding analysis failed: ${err.message}`);
        upsertOnboardingAnalysis(config, { status: 'error' });
      });
    }
  },
};
