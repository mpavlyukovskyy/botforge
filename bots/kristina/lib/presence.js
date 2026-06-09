/**
 * Atlas-presence guard (bleed-stopper).
 *
 * The financial/nudge crons read LOCAL SQLite and historically acted on tasks
 * that no longer exist in Atlas (deleted on the dashboard) — "ghosts" that get
 * nudged forever and charged real money (incident 2026-06-09: "Login to HSBC"
 * at -$3.00 was a ghost). This guard lets a cron skip any local row whose
 * `spok_id` is absent from the live Atlas board, and refuse to act at all when
 * Atlas cannot be verified.
 *
 * This is the interim guard until the full reconcile/outbox redesign lands;
 * the reconcile will make the local cache equal to Atlas so the predicate
 * becomes unnecessary. Kill-switch: env KRISTINA_EXCLUDE_ABSENT=0.
 */
import { fetchAtlasLiveIds } from './atlas-client.js';

export const PRESENCE_ENABLED = process.env.KRISTINA_EXCLUDE_ABSENT !== '0';

/**
 * Build a presence guard for one cron run.
 * @returns {Promise<{enabled:boolean, available:boolean, liveIds:Set<string>|null, skip:(task)=>boolean}>}
 *  - enabled:   the guard is on (env not disabled)
 *  - available: Atlas was reachable and the live id set was loaded
 *  - skip(task): true iff the task is a confirmed ghost (has a spok_id that is
 *                NOT live in Atlas). A row with spok_id == null is NEVER a
 *                ghost (it's not-yet-synced, not deleted) — never skipped.
 */
export async function loadAtlasPresence(ctx) {
  if (!PRESENCE_ENABLED) {
    return { enabled: false, available: false, liveIds: null, skip: () => false };
  }
  const liveIds = await fetchAtlasLiveIds(ctx);
  if (!liveIds) {
    return { enabled: true, available: false, liveIds: null, skip: () => false };
  }
  return {
    enabled: true,
    available: true,
    liveIds,
    skip: (task) => !!task?.spok_id && !liveIds.has(task.spok_id),
  };
}

/**
 * For destructive/financial crons: should the whole run be skipped because the
 * guard is on but Atlas could not be verified? Acting on unverifiable state is
 * exactly how ghosts got charged — when in doubt, do nothing this cycle.
 */
export function shouldSkipRun(presence) {
  return presence.enabled && !presence.available;
}
