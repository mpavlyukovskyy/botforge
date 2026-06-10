/**
 * Cron handler: reping_unacked
 *
 * Pings findlays-dashboard's /api/cron/reping-unacked endpoint, which finds
 * any online orders that have been unacknowledged for >15 min and sends a
 * Telegram reminder to the Findlays ops group (plus 30-min owner escalation).
 *
 * Configured to fire every 5 minutes (see hali99.yaml schedule).
 *
 * Auth: HALI99_SHARED_SECRET as Bearer token.
 *
 * DEAD-MAN'S SWITCH: this cron is the liveness probe for the whole order-
 * alert pipeline. Its previous incarnation swallowed 2,228 consecutive 404s
 * into a journal nobody reads (Jun 2026 silent outage). Now: after 3
 * consecutive non-2xx/fetch failures it DMs Mark directly, once per failure
 * episode, re-firing every 24h while the failure persists. Any 2xx resets
 * the episode (with a recovery DM if an alert had fired).
 *
 * State: JSON file at data/hali99-reping-state.json (relative to CWD
 * /opt/botforge, same convention as trainer's data/ dir). JSON over sqlite:
 * no native-ABI coupling, inspectable over ssh, reset-on-corrupt.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OWNER_CHAT_ID = '381823289'; // Mark's DM — already in hali99.yaml chat_ids
const FAIL_THRESHOLD = 3;
const REALERT_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = 'data/hali99-reping-state.json';

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { failCount: 0, lastAlertAt: 0 };
  }
}

function writeState(state) {
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    // State persistence failing must never break the cron itself.
    console.error(`[hali99/reping] state write failed: ${err?.message || err}`);
  }
}

async function onFailure(ctx, state, detail) {
  state.failCount += 1;
  ctx.log.error(`reping_unacked: ${detail} (consecutive failure #${state.failCount})`);

  if (state.failCount >= FAIL_THRESHOLD && Date.now() - state.lastAlertAt >= REALERT_MS) {
    state.lastAlertAt = Date.now();
    try {
      await ctx.adapter.send({
        chatId: OWNER_CHAT_ID,
        text:
          `⚠️ Hali99: order-alert pipeline endpoint DOWN (${state.failCount} consecutive failures)\n\n` +
          `${detail}\n\n` +
          `Unacked Findlays orders are NOT being re-pinged, and new-order alerts may also be broken.\n` +
          `Check: journalctl -u botforge-hali99 -n 50 on acemagic, and findlays-dashboard deploy/logs.`,
      });
      ctx.log.warn(`reping_unacked: dead-man DM sent to ${OWNER_CHAT_ID}`);
    } catch (err) {
      // DM failure must not mask the original error.
      ctx.log.error(`reping_unacked: dead-man DM failed: ${err?.message || err}`);
    }
  }
  writeState(state);
}

export default {
  name: 'reping_unacked',
  async execute(ctx) {
    const base = process.env.FINDLAYS_WEBSITE_URL;
    const secret = process.env.HALI99_SHARED_SECRET;
    if (!base || !secret) {
      ctx.log.warn('reping_unacked: FINDLAYS_WEBSITE_URL or HALI99_SHARED_SECRET not configured');
      return;
    }

    const state = readState();
    const url = `${base.replace(/\/$/, '')}/api/cron/reping-unacked`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        await onFailure(ctx, state, `HTTP ${res.status} from ${url} ${JSON.stringify(json)}`);
        return;
      }

      // Success: close out any open failure episode.
      if (state.failCount >= FAIL_THRESHOLD && state.lastAlertAt) {
        try {
          await ctx.adapter.send({
            chatId: OWNER_CHAT_ID,
            text: `✅ Hali99: order-alert pipeline endpoint recovered after ${state.failCount} failures.`,
          });
        } catch (err) {
          ctx.log.error(`reping_unacked: recovery DM failed: ${err?.message || err}`);
        }
      }
      if (state.failCount !== 0 || state.lastAlertAt !== 0) {
        writeState({ failCount: 0, lastAlertAt: 0 });
      }

      if (json.repinged > 0 || json.escalated > 0) {
        ctx.log.info(
          `reping_unacked: sent ${json.repinged} reminder(s), ${json.escalated ?? 0} escalation(s)`
        );
      }
    } catch (err) {
      await onFailure(ctx, state, `fetch failed: ${err?.message || err}`);
    }
  },
};
