/**
 * Whoop alert state machine — exactly ONE alert per condition, bounded
 * reminders, recovery notices. Replaces the alert-on-every-cron-tick pattern
 * that produced 267 identical Telegram messages in 24h
 * (docs/RCA-whoop-token-spam-2026-06-11.md).
 *
 * State lives in bot_state as JSON with epoch-second timestamps, so it is
 * cross-process and restart-proof, and emission is OBSERVATION-based: the cron
 * tick compares row truth (oauth_tokens.status) against alert-key presence.
 * That makes alerts idempotent no matter which process changed the row
 * (bot, backfill script, SSH re-auth, manual surgery).
 */

import { getState, setState, deleteState, nowSec, getOAuthToken } from './db.js';
import { REAUTH_CMD } from './whoop-client.js';

export const ALERT_KEYS = {
  dead: 'whoop_token_dead',
  config: 'whoop_config_error',
  transient: 'whoop_transient_outage',
  neverAuthorized: 'whoop_never_authorized',
};

// Reminder offsets from set_at: first reminder +6h, second +24h, then daily.
const REMINDER_OFFSETS_SEC = [6 * 3600, 24 * 3600];
const DAILY_SEC = 24 * 3600;
const TRANSIENT_ALERT_AFTER_SEC = 2 * 3600;

const RECOVERY_MESSAGES = {
  [ALERT_KEYS.dead]: '✅ Whoop token recovered — refresh working again. Recovery data resumes on the next sync.',
  [ALERT_KEYS.config]: '✅ Whoop client credentials working again.',
  [ALERT_KEYS.transient]: '✅ Whoop API recovered.',
  [ALERT_KEYS.neverAuthorized]: '✅ Whoop authorized.',
};

export function readAlertKey(config, key) {
  const raw = getState(config, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeAlertKey(config, key, obj) {
  setState(config, key, JSON.stringify(obj));
}

export function clearAlertKey(config, key) {
  deleteState(config, key);
}

async function send(ctx, text) {
  const chatId = ctx.store?.get('chat_id')
    || ctx.config.platform?.chat_ids?.[0]
    || process.env.TRAINER_CHAT_ID;
  if (!chatId) return;
  try {
    await ctx.adapter.send({ chatId, text });
  } catch {
    // Can't alert — the fleet-watchdog freshness check is the backstop.
  }
}

function reminderDue(state) {
  const now = nowSec();
  const count = state.count || 1;
  let dueAt;
  if (count - 1 < REMINDER_OFFSETS_SEC.length) {
    dueAt = state.set_at + REMINDER_OFFSETS_SEC[count - 1];
  } else {
    dueAt = (state.last_sent_at || state.set_at) + DAILY_SEC;
  }
  return now >= dueAt;
}

/**
 * Raise (or remind about) a deduplicated alert. Sends the full message once,
 * then bounded reminders. Safe to call on every cron tick.
 */
export async function ensureAlert(ctx, key, message) {
  const state = readAlertKey(ctx.config, key);
  if (!state) {
    await send(ctx, message);
    writeAlertKey(ctx.config, key, { set_at: nowSec(), last_sent_at: nowSec(), count: 1, message });
    return 'alerted';
  }
  if (reminderDue(state)) {
    await send(ctx, `⏰ Reminder (${state.count}): ${state.message}`);
    writeAlertKey(ctx.config, key, { ...state, last_sent_at: nowSec(), count: state.count + 1 });
    return 'reminded';
  }
  return 'deduped';
}

/** Clear a key, sending its recovery notice iff it was set. */
export async function clearWithRecovery(ctx, key) {
  const state = readAlertKey(ctx.config, key);
  if (!state) return false;
  clearAlertKey(ctx.config, key);
  await send(ctx, RECOVERY_MESSAGES[key] || `✅ Recovered: ${key}`);
  return true;
}

export function deadAlertMessage(row) {
  const since = row?.dead_at ? new Date(row.dead_at * 1000).toISOString() : 'unknown';
  return [
    `⚠️ Whoop token is DEAD (${row?.dead_reason || 'unknown'}, since ${since}).`,
    'Refresh is permanently failing — re-authorization needed (browser, ~3 min):',
    REAUTH_CMD,
    '',
    'Until then: workouts continue without recovery data. No more spam — reminders at +6h, +24h, then daily.',
  ].join('\n');
}

/**
 * Observation-based sweep, called from the token-refresh cron each tick.
 * Compares row truth against alert-key state and emits exactly the right
 * messages. `row` may be null (never authorized).
 */
export async function sweepWhoopAlerts(ctx, row) {
  const cfg = ctx.config;

  if (!row || !row.refresh_token) {
    if (row && (row.expires_at || 0) > nowSec()) return; // access-only token still working
    await ensureAlert(ctx, ALERT_KEYS.neverAuthorized,
      `⚠️ Whoop is not authorized (no ${row ? 'refresh' : 'OAuth'} token). Authorize with:\n${REAUTH_CMD}`);
    return;
  }

  if (row.status === 'dead') {
    // Death supersedes a transient-outage episode — clear it silently.
    clearAlertKey(cfg, ALERT_KEYS.transient);
    await ensureAlert(ctx, ALERT_KEYS.dead, deadAlertMessage(row));
    return;
  }

  // status active: anything previously alerted has recovered.
  for (const key of Object.values(ALERT_KEYS)) {
    if (key === ALERT_KEYS.transient) {
      // Transient clears only once a refresh actually succeeded — signalled by
      // the row's window stamp being reset (success CAS nulls it).
      if (row.first_transient_failure_at == null) await clearWithRecovery(ctx, key);
    } else {
      await clearWithRecovery(ctx, key);
    }
  }
}

/**
 * Called on a transient refresh failure: alert once if the outage has been
 * continuous for >2h, with the last raw provider error included.
 */
export async function transientOutageCheck(ctx, row, lastError) {
  const since = row?.first_transient_failure_at;
  if (!since) return;
  const elapsed = nowSec() - since;
  if (elapsed < TRANSIENT_ALERT_AFTER_SEC) return;
  const hours = Math.floor(elapsed / 3600);
  await ensureAlert(ctx, ALERT_KEYS.transient,
    `⚠️ Whoop API failing continuously for ${hours}h (since ${new Date(since * 1000).toISOString()}).\nLast error: ${lastError}\nNo action needed — this recovers automatically; I'll confirm when it does.`);
}

/** Raise the config-error alert (env/credentials — re-auth would not fix it). */
export async function configErrorAlert(ctx, message) {
  await ensureAlert(ctx, ALERT_KEYS.config,
    `⚠️ Whoop client credential problem: ${message}\nFix WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET in /opt/botforge/.env on acemagic. Re-auth will NOT fix this.`);
}

/**
 * One-line Whoop health banner for user-facing commands (/sync, /status,
 * /progress) — null when healthy. Commands must never imply Whoop data is
 * flowing when the token is dead.
 */
export function whoopStatusLine(config) {
  let row;
  try {
    row = getOAuthToken(config, 'whoop');
  } catch {
    return null;
  }
  if (!row || !row.refresh_token) {
    return `⚠️ Whoop not authorized — run: ${REAUTH_CMD}`;
  }
  if (row.status === 'dead') {
    const since = row.dead_at ? new Date(row.dead_at * 1000).toISOString().slice(0, 16) : '?';
    return `⚠️ Whoop token dead since ${since} — re-auth: ${REAUTH_CMD}`;
  }
  return null;
}
