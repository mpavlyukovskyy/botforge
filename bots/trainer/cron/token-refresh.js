/**
 * Cron handler: token_refresh
 *
 * Runs every 5 minutes (offset minutes 2,7,…,57 — see trainer.yaml) with THREE
 * INDEPENDENT sections. A failure or skip in one section must never affect the
 * others — in particular, a dead Whoop token must not stop Hevy workout sync
 * or Telegram offset persistence (they are unrelated subsystems).
 *
 *   1. Whoop token upkeep + observation-based alerting (lib/alert-state.js).
 *      Dead token → dead-skip, no HTTP (except the 12h escape-hatch probe),
 *      ONE alert with bounded reminders — never the 5-minute spam loop again.
 *   2. Hevy workout-event polling (real-time completion sync).
 *   3. Telegram polling-offset persistence (crash resilience).
 */
import {
  ensureDb, getOAuthToken, nowSec, casClaimDeadProbe,
  getState, setState,
  upsertWorkoutCache,
} from '../lib/db.js';
import {
  refreshAccessToken,
  ReauthRequiredError, RefreshUnavailableError, WhoopConfigError, WhoopTransientError,
} from '../lib/whoop-client.js';
import {
  sweepWhoopAlerts, transientOutageCheck, configErrorAlert,
} from '../lib/alert-state.js';
import { getWorkoutEvents, parseWorkoutForCache } from '../lib/hevy-client.js';

const REFRESH_MARGIN_SEC = 600;

export default {
  name: 'token_refresh',
  async execute(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return; // DB not ready
    }

    // ── Section 1: Whoop token ────────────────────────────────────────────
    try {
      await whoopTokenSection(ctx);
    } catch (err) {
      ctx.log.error(`whoop section unexpected error: ${err.message}`);
    }

    // ── Section 2: Hevy workout event polling ─────────────────────────────
    try {
      await hevyPollSection(ctx);
    } catch (err) {
      ctx.log.warn(`hevy-poll error: ${err.message}`);
    }

    // ── Section 3: Telegram polling-offset persistence (never skipped) ────
    try {
      if (ctx.adapter.getPollingOffset) {
        const offset = ctx.adapter.getPollingOffset();
        if (offset > 0) {
          setState(ctx.config, 'telegram_polling_offset', String(offset));
        }
      }
    } catch (err) {
      ctx.log.warn(`offset-persist error: ${err.message}`);
    }
  },
};

async function whoopTokenSection(ctx) {
  let row = getOAuthToken(ctx.config, 'whoop');

  // Observation-based alert/recovery sweep — idempotent, row-truth driven.
  await sweepWhoopAlerts(ctx, row);

  if (!row || !row.refresh_token) {
    ctx.log.info('whoop: no-token-skip');
    return;
  }

  if (row.status === 'dead') {
    // Escape hatch: one CAS-claimed verification refresh per 12h, anchored at
    // dead_at + 12h. A false-positive death self-heals; a real one just gets
    // another 400.
    if (casClaimDeadProbe(ctx.config, 'whoop', row.refresh_token)) {
      try {
        await refreshAccessToken(ctx.config);
        ctx.log.info('whoop: dead-probe succeeded — token revived');
        await sweepWhoopAlerts(ctx, getOAuthToken(ctx.config, 'whoop'));
      } catch (err) {
        ctx.log.info(`whoop: dead-probe still failing (${err.message})`);
      }
    } else {
      ctx.log.info('whoop: dead-skip (reauth pending)');
    }
    return;
  }

  if ((row.expires_at || 0) > nowSec() + REFRESH_MARGIN_SEC) {
    ctx.log.info('whoop: valid-skip');
    return;
  }

  try {
    await refreshAccessToken(ctx.config);
    ctx.log.info('whoop: refreshed');
    // A success may end a dead/config/transient episode — sweep clears keys
    // and sends the recovery notice.
    await sweepWhoopAlerts(ctx, getOAuthToken(ctx.config, 'whoop'));
  } catch (err) {
    if (err instanceof WhoopConfigError) {
      ctx.log.error(`whoop: config-error: ${err.message}`);
      await configErrorAlert(ctx, err.message);
    } else if (err instanceof ReauthRequiredError) {
      ctx.log.error(`whoop: token dead: ${err.message}`);
      await sweepWhoopAlerts(ctx, getOAuthToken(ctx.config, 'whoop'));
    } else if (err instanceof RefreshUnavailableError) {
      ctx.log.info('whoop: refresh in progress elsewhere — skip');
    } else if (err instanceof WhoopTransientError && err.invalidRequestCount != null) {
      ctx.log.warn(`whoop: transient-fail (invalid_request ${err.invalidRequestCount}/3): ${err.message}`);
    } else {
      ctx.log.warn(`whoop: transient-fail: ${err.message}`);
      await transientOutageCheck(ctx, getOAuthToken(ctx.config, 'whoop'), err.message);
    }
  }
}

async function hevyPollSection(ctx) {
  if (!process.env.HEVY_API_KEY) {
    ctx.log.info('hevy-poll: skipped (no HEVY_API_KEY)');
    return;
  }

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

  let synced = 0;
  for (const event of allEvents) {
    if (event.type !== 'updated' || !event.workout) continue;
    const cached = parseWorkoutForCache(event.workout);
    upsertWorkoutCache(ctx.config, cached);
    synced++;
  }

  setState(ctx.config, 'last_events_since', pollTime);
  ctx.log.info(`hevy-poll ok (${synced} event${synced === 1 ? '' : 's'})`);
}
