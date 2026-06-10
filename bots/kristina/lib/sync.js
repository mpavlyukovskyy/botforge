/**
 * Reconcile: make the local SQLite cache exactly equal Atlas truth.
 *
 * The fundamental fix for the "two sources of truth" class (incidents
 * 2026-06-07/09). Crons + the brain historically diverged because the local
 * cache was never reconciled against Atlas — a task deleted in the dashboard
 * lived on locally as an immortal "ghost" that got nudged and charged.
 *
 * reconcile() pulls the FULL Atlas snapshot (all statuses, all months, incl.
 * soft-deleted tombstones via /items?all=1&includeDeleted=1) and converges
 * local to it:
 *   - upsert every live (non-deleted) Atlas row into local, matched by
 *     spok_id (Atlas cuid) or healed by external_id (a task created offline
 *     then synced, or created on the dashboard);
 *   - reap local rows that were synced (spok_id NOT NULL) but are absent from
 *     the snapshot, or whose Atlas row is soft-deleted — these are genuinely
 *     gone, so the local ghost is removed;
 *   - NEVER reap a local row with spok_id IS NULL — it's not-yet-synced, not
 *     deleted (the retry/outbox owns it).
 *
 * Safe-abort: if Atlas is unverifiable (circuit open / fetch failed) or the
 * snapshot is suspiciously empty while the local cache is non-empty, it does
 * NOT touch the cache (never reap on a bad snapshot) and returns a report the
 * caller can alert on.
 */
import { ensureDb, fetchAtlasSnapshot, reconcileDeductions } from './atlas-client.js';

export const RECONCILE_ENABLED = process.env.KRISTINA_RECONCILE !== '0';

let _running = false; // in-process guard: never overlap two reconciles

export async function reconcile(ctx) {
  if (!RECONCILE_ENABLED) return { skipped: 'disabled' };
  if (_running) return { skipped: 'already-running' };
  _running = true;
  try {
    const db = ensureDb(ctx.config);
    const localCount = db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;

    const snapshot = await fetchAtlasSnapshot(ctx);
    if (snapshot === null) {
      ctx.log?.warn?.('[reconcile] Atlas unverifiable — aborting (no cache change)');
      return { aborted: 'atlas-unverifiable', localCount };
    }
    // Suspicious-empty guard: a 0-row snapshot while we hold many local rows is
    // far more likely a backend glitch than a truly empty board — never reap.
    if (snapshot.length === 0 && localCount > 0) {
      ctx.log?.warn?.(`[reconcile] empty snapshot but ${localCount} local rows — aborting (suspect)`);
      return { aborted: 'suspect-empty', localCount };
    }

    const live = snapshot.filter(i => !i.deletedAt);
    const liveIds = new Set(live.map(i => i.id));

    const findByCuid = db.prepare("SELECT id, spok_id FROM tasks WHERE spok_id = ?");
    const findByExt = db.prepare("SELECT id, spok_id FROM tasks WHERE id = ?");
    const insertRow = db.prepare(
      `INSERT INTO tasks (id, spok_id, title, column_name, column_id, assignee, deadline, status, earned_status, current_value, requester, requester_chat_id, priority_tier, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
    );
    const updateRow = db.prepare(
      `UPDATE tasks SET spok_id = ?, title = ?, column_name = ?, column_id = ?, assignee = ?, deadline = ?, status = ?, earned_status = ?, current_value = ?, requester = ?, priority_tier = ?, synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    );

    let upserted = 0, inserted = 0, reaped = 0;

    const apply = db.transaction(() => {
      // 1) Upsert every live Atlas row into local (Atlas is the truth).
      for (const a of live) {
        const earnedValue = a.earnedValue != null ? Number(a.earnedValue) : null;
        const tier = a.priorityTier || 'STANDARD';
        let localRow = findByCuid.get(a.id);
        if (!localRow && a.externalId) localRow = findByExt.get(a.externalId); // heal/link
        if (localRow) {
          updateRow.run(a.id, a.title, a.columnName || null, a.columnId || null, a.assignee || null,
            a.deadline || null, a.status, a.earnedStatus || null, earnedValue, a.requester || null, tier, localRow.id);
          upserted++;
        } else {
          // A task that exists in Atlas but not locally (e.g. created on the
          // dashboard). Learn it. Use the Atlas cuid as the local id too.
          insertRow.run(a.externalId || a.id, a.id, a.title, a.columnName || null, a.columnId || null,
            a.assignee || null, a.deadline || null, a.status, a.earnedStatus || null, earnedValue,
            a.requester || null, a.requesterChatId || null, tier);
          inserted++;
        }
      }
      // 2) Reap synced local rows that Atlas no longer has (deleted/absent).
      //    NEVER reap spok_id IS NULL (not-yet-synced; the retry owns it).
      const syncedLocal = db.prepare("SELECT id, spok_id FROM tasks WHERE spok_id IS NOT NULL").all();
      const del = db.prepare("DELETE FROM tasks WHERE id = ?");
      for (const row of syncedLocal) {
        if (!liveIds.has(row.spok_id)) { del.run(row.id); reaped++; }
      }
    });
    apply();

    // Converge deduction reversal/contest state from Atlas (two-way for
    // deductions: bot creates them, dashboard can reverse/contest them).
    let deductionsChanged = null;
    try { deductionsChanged = await reconcileDeductions(ctx); } catch { /* non-fatal */ }

    const report = { ok: true, snapshot: snapshot.length, live: live.length, upserted, inserted, reaped, localBefore: localCount, deductionsChanged };
    if (reaped > 0 || inserted > 0 || deductionsChanged) ctx.log?.info?.(`[reconcile] ${JSON.stringify(report)}`);
    return report;
  } finally {
    _running = false;
  }
}
