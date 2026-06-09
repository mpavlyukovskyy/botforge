# Kristina fundamental fix — FINAL vetted plan (post 2nd red-team)

**Design = v2 (thin client: Atlas truth, local = snapshot cache + outbox, derived decay computed-not-stored).** This doc records the DELTAS forced by the 2nd red-team and the final, reordered, flag-gated, test-gated execution sequence. Read v2 §A/§B for design rationale.

## Deltas forced by 2nd red-team (all folded into the sequence below)
- **DR-1 Migration:** add handoff columns to `schema.prisma` + commit the orphan `20260331050000_add_handoff_fields` migration FIRST; `prisma migrate status`; branch on applied/pending; use **`migrate deploy`** only (never `migrate dev` on prod). Verified backup artifact gates the migration.
- **DR-2 Bleed-stopper FIRST (Step 0.0):** bot-only, flag-gated exclusion of ghost rows (local OPEN with a `spok_id` that 404s on Atlas) from decay/nudge/deduction crons. Stops live money loss before anything else.
- **DR-3 Atomic backend deploy:** column-add + Prisma `deletedAt:null` extension + soft-delete switch ship in ONE deploy; verify the still-old prod bot sees no change.
- **DR-4 Prisma extension trap:** `findUnique` cannot take a non-unique `where`; the extension rewrites TaskItem `findUnique`→`findFirst` (or post-filters). Covered by test.
- **DR-5 Dashboard earnedStatus timing:** keep the dashboard's `earnedStatus='EARNED'` write UNTIL the bot can compute `earnedValue` (Phase 3); then (a) drop it AND (b) rewrite `getTaskBillingStats` to sum `earnedValue` (with `earnedStatus` fallback) — engineer the parity, don't just assert it. Decimal(10,2) vs JS round reconciled in the parity test.
- **DR-6 billingMonth:** one-time backfill (OPEN, prior months → current) + change read filter to `billingMonth <= current` for OPEN (so nothing strands) + remove write-on-read from BOTH `ensureCurrentMonthSync` (route) and `ensureCurrentMonth` (dashboard); `?all=1` drops the month filter entirely.
- **DR-7 Reconcile ordering (R15):** node-cron gives no cross-job ordering → reconcile is called as the **first awaited step inside each destructive/financial cron** (and a `reconciled_at` freshness row; crons abort if stale/Atlas-unreachable). Not "scheduled before."
- **DR-8 Lost-update fence (R2/R13):** reconcile never overwrites a cache row whose local `updated_at` is newer than the snapshot's capture time; cache writes + reconcile transaction guarded by a single in-process mutex.
- **DR-9 Reconcile safety:** flag-gated (`reconcileEnabled`, `outboxEnabled` default off), first run in **dry-run** (log+Argus the would-reap/would-create set), cold-start tolerant (mp-atlas auto-stops → slow/partial response = suspect-abort, never reap). Verify externalId backfill complete (count match, no dup-cuid) before any delete.
- **DR-10 Alerting in Phase 2** (not 4): Argus on reconcile-abort/reap-count/outbox-quarantine from first live reconcile.
- **DR-11 done_notification:** folded INTO reconcile; the standalone cron is removed (or repointed to `done_notified_at`); notify-once via atomic `UPDATE … WHERE done_notified_at IS NULL`.
- **DR-12 undo/tombstone:** `undo` + `reopen-from-tombstone` added to the `applyTransition` op set with defined un-tombstone semantics. Tombstone GC: reconcile stops pulling tombstones older than 30d; periodic hard-purge.
- **DR-13 finance-app test harness:** stand up a DB-backed vitest harness + throwaway Postgres (mirror the spok-v2 pattern) — required or the backend tests can't run at all.
- **DR-14 clock:** all decay/earnedValue compute plumbs an injectable `now`; tests pin it. Assume bot/Atlas clocks within tolerance (documented).
- **DR-15 requester filter:** unify in `getBoardView`; route commands + record_deduction + create_task through it too.
- **DR-16 Fly rollback:** record `flyctl releases -a mp-atlas` previous image before each backend deploy; 5–10 min monitor per deploy.

## FINAL ordered sequence (each: implement → test → deploy → verify; reversible)

**Phase 0 — Stop the bleed + ground truth**
- 0.0 **Bleed-stopper** (bot, flag `excludeAtlasAbsentTasks` default ON): crons skip local rows whose `spok_id` 404s on Atlas. +test. Deploy kristina. Verify the 7 ghosts stop nudging/charging.
- 0.1 Fly MPG proxy; **verified DB backup**; `prisma migrate status` on mp-atlas; capture.
- 0.2 Add handoff cols to schema.prisma + commit orphan migration; resolve drift to clean status (branch on applied/pending).
- 0.3 Snapshot local DB + Atlas board (forensic baseline).

**Phase 1 — Backend foundation (finance-app → mp-atlas), atomic deploys, additive+backward-compatible**
- 1.A (one deploy) Prisma soft-delete extension (`findMany/findFirst/findUnique→findFirst/count/aggregate/groupBy/updateMany` inject `deletedAt:null`) + migration adding `externalId @unique, earnedValue, handedOffAt, handedOffNote, deletedAt` (nullable, no defaults) + switch API DELETE + dashboard `deleteTaskItem` to soft-delete. +tests (DB harness DR-13). Record prev image. Deploy. Verify old bot unaffected.
- 1.B `GET ?all=1&includeDeleted=1` read-only (no month side-effect, no month filter). +test. Deploy.
- 1.C POST upsert-on-externalId (null→plain create) + `toValidDate`. +idempotency test. Deploy.
- 1.D PATCH persists earnedValue/earnedStatus/handedOff*; `completedAt = existing ?? now`. +test. Deploy.
- 1.E billingMonth: one-time backfill + read filter `<= current` for OPEN + remove write-on-read (both copies). +test. Deploy. Verify dashboard board+stats intact.

**Phase 2 — Bot identity + sync core (flag-gated, dry-run first)**
- 2.0 Flags `reconcileEnabled`/`outboxEnabled` default OFF. Local schema: add `external_id, earned_value, handed_off_at/note, reconciled_at, done_notified_at, decay_notified_threshold`; backfill `external_id=id`. One-time idempotent Atlas `externalId` backfill from local (guarded, count-verified, no dup-cuid).
- 2.1 `lib/sync.js`: outbox (FIFO/depends_on/quarantine-on-4xx/breaker-isolation/idempotent) + reconcile (snapshot-replace in one txn + mutex + updated_at fence + safe-abort on fail/empty/cold-start + dry-run mode). `createItem`/mutations → outbox-on-failure (never null-drop). +`lib/sync.test.js` (incl. first-reconcile-vs-real-divergent-state, lost-update, ghost-reap). Argus alerting (DR-10).
- 2.2 Deploy dark; enable dry-run; review would-reap (should = the ghosts); enable live. Verify reconcile reaps ghosts, no dup on offline-create.

**Phase 3 — Lifecycle + view + balance authority**
- 3.1 `lib/lifecycle.js applyTransition` ({markDone w/ frozen earnedValue, reopen, archive, cancel, handoff, setDeadline, moveColumn, undo}) + ONE id resolver (retire dup findTaskByIdPrefix) + injectable clock. +`lib/lifecycle.test.js`. Repoint all tools/callbacks.
- 3.2 `lib/board-view.js getBoardView` (full lifecycle, live-decay computed, unified requester+admin filter, excludes deleted/tombstoned). Repoint board-state, query_board, crons, commands, record_deduction. +test.
- 3.3 Fold done-propagation into reconcile (atomic notify-once); remove standalone done_notification; split notified_at. +test.
- 3.4 Dashboard: drop `earnedStatus='EARNED'` on done; rewrite `getTaskBillingStats` to sum `earnedValue` (+fallback); reconcile computes earnedValue for DONE-without-it. +balance-parity test (bot==dashboard, Decimal fixtures). Deploy backend + bot. Verify parity + board shows OVERDUE w/ value.

**Phase 4 — Coherence + crons + alerting hardening**
- 4.1 Proactive senders embed `ID:<cuid8>` + write `message_refs` + history; reply-context consumes `loadMessageRefs`. +test.
- 4.2 Each destructive/financial cron calls `reconcile()` first + aborts if stale/Atlas-down; auto-archive via applyTransition (notify, no silent vanish). +cron-no-ghost test.
- 4.3 Full alerting in healthcheck-ping (circuit>15m, outbox backlog/quarantine, reconcile abort). Tombstone GC.
- 4.4 Deploy. Verify reply-"done"-to-nudge resolves by id; cron never acts on absent task.

**Phase 5 — Full verification**
- 5.1 All e2e smokes (v2 §C, against stubbed Atlas, pinned clock). 5.2 Three-symptoms-impossible deterministic tests pass. 5.3 Docs + memory.

## Rollback per phase
- 0.0 / 2.x / 3.x / 4.x bot: flag-flip to false + bot auto-rollback on healthcheck; data-restore from 0.3 snapshot.
- Backend: `flyctl deploy --image <prev>` (recorded each deploy); additive columns are inert if unused.
- Migration: gated on verified backup; additive-nullable only.
