# Kristina fundamental fix — Plan v2 (post-red-team) + execution sequence

**Supersedes v1.** Incorporates all findings from the 3-agent red-team (data/migration, resilience/concurrency, scope/omissions).
**Core change from v1:** the bot becomes a genuinely THIN CLIENT. Local SQLite = a read snapshot of Atlas + a write outbox. Derived values (live decay) are computed, never stored. This eliminates the version-column, merge, lost-update, decay-flap, and reap-predicate complexity that v1 introduced.

---

## A. Design principles (v2)

1. **Atlas = truth. Bot local = (a) cache: the last full Atlas snapshot; (b) outbox: pending writes made while offline.** The cache has NO independent authoritative writes to lose. Reconcile = replace the cache with a fresh snapshot in one transaction. "Reaping" is automatic: a task absent from the snapshot is simply not in the cache.
2. **Derived vs frozen state.**
   - *Live decay value* (the "-$3.00" for an OPEN overdue task) = a pure function of `deadline, now, handedOffAt`. **Computed on read, never stored.** (Kills the decay write-race + flapping outright.)
   - *Earned value* (the bounty captured when a task is completed) = **frozen once at done-time**, stored in Atlas as `earnedValue`. Computed by ONE authority (the bot — see §B6).
3. **One identity.** Atlas `id` (cuid) = canonical id everywhere (board, messages, reconcile match). `externalId` (bot-minted UUID) = idempotency key for create + addressing of outbox ops before the cuid exists. Atlas resolves PATCH/DELETE by `externalId` OR `id`.
4. **One lifecycle authority.** A task's `status` + `earnedStatus` + `earnedValue` are computed in exactly one place. The dashboard sets only `status`/`completedAt` on a drag-to-Done; the bot is the sole writer of `earnedStatus`/`earnedValue` (via transition and via reconcile detecting newly-DONE-without-earnedValue). Balance is summed from Atlas `earnedValue` by one formula → bot `get_balance` and dashboard stats agree by construction.
5. **No silent drops, no poison stalls.** Every mutation either reaches Atlas or is durably queued in the outbox. Per-item failure isolation: a 4xx quarantines that one item without tripping the shared circuit breaker; only 5xx/network counts toward the breaker.
6. **Reconcile is safe-by-default.** It refuses to replace the cache from a failed or suspicious snapshot (count 0 while cache non-empty, or circuit open). It runs before every destructive/financial cron.
7. **Coherence.** Every proactive message embeds `ID:<cuid8>` and writes a `message_refs` row + history line; replies resolve by id, never by title.

---

## B. Concrete changes (with red-team fixes folded in)

### B1. PRE-WORK — resolve prod migration drift (BLOCKER, do before any schema change)
`finance-app/prisma/migrations/20260331050000_add_handoff_fields/` is **untracked in git** and `schema.prisma` doesn't contain handoff columns. Before touching the schema: start the Fly MPG proxy, run `npx prisma migrate status` against mp-atlas to learn applied-vs-pending truth; reconcile schema.prisma + commit/baseline the orphan migration (`migrate resolve --applied` if already on prod). **Back up the DB first** (`fly mpg` backup). No `migrate deploy` until status is clean.

### B2. Atlas schema (additive, nullable, NO non-null defaults → metadata-only, no table rewrite)
Add to `TaskItem`: `externalId String? @unique`, `earnedValue Decimal?`, `handedOffAt DateTime?`, `handedOffNote String?`, `deletedAt DateTime?`. Keep `earnedStatus` as **`String?`** (do NOT convert to a pg enum — live data holds `OVERDUE`/`PENALTY`/`CANCELLED`; a cast would fail). No `currentValue` column (live value is derived).
- Backfill `externalId` for existing rows **from the bot's local DB** (`spok_id → local id` join), NOT from the cuid. Dashboard-only rows keep `externalId=NULL` and are matched by cuid.

### B3. Soft-delete with a single read chokepoint (fixes the 8-site omission)
Add a **Prisma client extension** that injects `deletedAt: null` into `findMany/findFirst/findUnique/count/aggregate/updateMany` for `TaskItem`. Switch API `DELETE` and dashboard `deleteTaskItem` to set `deletedAt=now()`. This makes deleted-task exclusion a single chokepoint instead of 14 hand-edited queries, and lets reconcile distinguish "deleted" from "never synced."

### B4. Reconcile read endpoint (no side effects)
New read-only mode `GET /items?all=1&includeDeleted=1` that returns every task (all statuses + `deletedAt`) and **does NOT call `ensureCurrentMonthSync`** (remove the write-on-read month mutation from this path; move month-rollover to its own scheduled job or to create-time). Returns `id, externalId, status, earnedStatus, earnedValue, deadline, handedOffAt, columnId/name, assignee, requester, deletedAt, updatedAt`.

### B5. Bot: cache + outbox + reconcile (`lib/sync.js`, refactor `lib/atlas-client.js`)
- **Cache** = local `tasks` mirror of the snapshot (existing table, repurposed; add `external_id`, `earned_value`, `handed_off_at/note`, `reconciled_at`; drop reliance on `current_value`/`notified_at` overload).
- **reconcile(ctx):** if circuit open → skip. GET full snapshot. If GET failed OR (snapshot empty AND cache non-empty) → **abort, alert, do not touch cache**. Else replace cache in ONE `db.transaction()`: upsert every snapshot row by cuid; delete cache rows whose cuid is absent from the snapshot AND that have no pending outbox op. Never delete a cache row that has `spok_id IS NULL` (never synced) or a pending outbox create.
- **Outbox** table `outbox(id, external_id, op, payload_json, depends_on, attempts, quarantined_at, last_error, created_at)`. Mutations enqueue FIFO per `external_id`; a mutation `depends_on` its create. Flush in per-task order; if a create is quarantined, its dependents wait. 4xx → `quarantined_at` set, alert, do NOT hit breaker. 5xx/network → leave queued, count breaker. Flush is idempotent (create via externalId upsert; PATCH is a frozen-value set).
- **createItem / applyTransition on open circuit → enqueue to outbox and return the local row** (never return null / "saved locally only" dead-end).
- **View = cache(deletedAt null, not-tombstoned) ∪ outbox-pending-creates.**

### B6. Bot: one lifecycle/transition + earned-value authority (`lib/lifecycle.js`)
- `applyTransition(ctx, ref, op, opts)` for `{markDone, reopen, archive, cancel, handoff, setDeadline, moveColumn}`. Resolves `ref` (cuid or externalId or 8-char prefix) via ONE resolver (retire the duplicate `findTaskByIdPrefix`). Computes the resulting state in one place; for `markDone` computes **earnedValue** (decay/handoff-aware, porting the logic from the dead `markTaskDoneLocally`) and sets `earnedStatus`. Writes Atlas (or outbox), then updates cache. PATCH payload carries the **frozen** earnedValue/earnedStatus/completedAt so a retry replays identical bytes; Atlas keeps `completedAt = existing ?? now`.
- **Dashboard** (`tasks.ts moveTaskItem/updateTaskItem`): on drag-to-Done set only `status=DONE` + `completedAt`; STOP setting `earnedStatus=EARNED`. The bot's reconcile detects `status=DONE AND earnedValue IS NULL` and computes+writes earnedValue once → single authority, no double-coupling.
- Retire dead `markTaskDoneLocally`; split `notified_at` → `decay_notified_threshold` + `done_notified_at`; one `done`-propagation owner (fold into reconcile; notify via atomic `UPDATE … WHERE done_notified_at IS NULL` and DM only if `changes===1`).

### B7. Bot: one task-view (`lib/board-view.js`)
`getBoardView(ctx, {scopeToRequester, statuses})` reads the cache, computes live decay for OPEN-overdue rows, applies requester+admin filtering in ONE place (retire the 5 inlined copies; digest currently uses a looser predicate — unify), excludes deleted/tombstoned. Consumed by `board-state.js`, `query_board.js`, and every cron. `board_state` renders OPEN incl. OVERDUE with live value + earnedStatus; never claims "removed."

### B8. Bot: proactive coherence (crons + reply-context)
Every proactive sender (`decay-check`, `deadline-expiry`, `nudge-send`, `daily-digest`) embeds `ID:<cuid8>` and writes a `message_refs(msg_id→task_id)` row + a conversation-history line. Wire a reply-context builder that calls the already-existing `loadMessageRefs(replyToMsgId)` (currently defined but never consumed) so a reply ("done") resolves to the task id. Do NOT add a parallel table.

### B9. Crons read truth, act only on fresh data
All crons consume `getBoardView` (post-reconcile). Reconcile runs at :00/:15/:30/:45, strictly before the :00/:15 decay/expiry crons. Destructive/financial crons (deductions, auto-archive) **skip if Atlas was unreachable this cycle** (no acting on stale). `auto-archive` routes through `applyTransition` (observable/reconciled); keep the 14-day rule but notify + leave brain-visible state (no silent vanish).

### B10. Alerting (`cron/healthcheck-ping.js`)
Alert to Argus Telegram on: circuit open > 15 min; outbox backlog > N or any `quarantined_at`; reconcile snapshot-suspect/abort. (Both the 3-day outage and the 7 ghosts ran unnoticed.)

---

## C. Test suite (every new component; vitest in bot, backend tests in finance-app)
- `lib/lifecycle.test.js` — each transition legal/illegal; status×earnedStatus×column coherence; **markDone sets earnedValue (+$1.00 on-time, decayed when late, frozen on handoff)**; idempotent replay writes identical bytes.
- `lib/sync.test.js` — reconcile: snapshot-replace; never reap `spok_id NULL` or outbox-pending; abort on empty/failed snapshot; transactional/crash-safe. Outbox: FIFO per task; create-before-dependent; 4xx quarantine without breaker; 5xx retry; idempotent flush (no dup); open-circuit enqueue.
- `lib/board-view.test.js` — full-lifecycle shape; live-decay computed; OVERDUE surfaced; deleted/tombstoned excluded; requester+admin filter; stale flag.
- `lib/decay`/working-hours — keep existing; assert earnedValue formula.
- backend `items.route.test` — upsert-on-externalId idempotency (null-externalId → plain create); soft-delete; `?all=1&includeDeleted=1` returns deleted + no month side-effect; Prisma extension hides deletedAt from normal reads.
- backend balance parity test — bot formula == dashboard `getTaskBillingStats` on the same Atlas data.
- e2e smokes: (a) create→sync→dashboard-delete→reconcile→cron-skips→brain-won't-recreate; (b) offline-create→recover→no-dup (externalId); (c) offline-**mutation**(mark_done)→recover→Atlas DONE; (d) dashboard-drag-to-Done→reconcile→bot earnedValue set & balance matches; (e) decay-write vs done-notify same row no double/again; (f) auto-archive doesn't silently vanish; (g) offline-undo→recover→stays deleted.

---

## D. Execution sequence (ordered, each step: implement → test → deploy → verify; reversible)

**Phase 0 — Ground truth & safety (no prod writes)**
0.1 Start Fly MPG proxy; `prisma migrate status` on mp-atlas; capture applied/pending. Back up the DB.
0.2 Resolve the untracked `add_handoff_fields` drift (commit/baseline + reconcile schema.prisma). Confirm clean status.
0.3 Snapshot current local DB + Atlas board (forensic baseline; we already know 7 ghosts).

**Phase 1 — Backend foundation (finance-app), deploy mp-atlas**
1.1 Prisma extension: `deletedAt: null` chokepoint for TaskItem reads. + tests.
1.2 Schema migration: add `externalId @unique, earnedValue, handedOffAt, handedOffNote, deletedAt` (nullable, no defaults). Migrate.
1.3 Soft-delete: API DELETE + dashboard `deleteTaskItem` → `deletedAt`. + tests.
1.4 `GET ?all=1&includeDeleted=1` read-only path (no `ensureCurrentMonthSync`). + test.
1.5 POST upsert-on-externalId (null → plain create) with `toValidDate`. + idempotency test.
1.6 PATCH persists `earnedValue/earnedStatus/handedOff*`; `completedAt = existing ?? now`. + test.
1.7 Dashboard move/update: set only `status/completedAt` on done (drop `earnedStatus=EARNED`). + test.
1.8 Remove `ensureCurrentMonthSync` write-on-read; move month attribution to create-time. Align stats. + test.
1.9 Deploy mp-atlas; verify reads exclude deleted, `?all=1` works, upsert idempotent (live curl), existing board intact.

**Phase 2 — Bot identity + sync core (botforge), deploy kristina**
2.1 Local schema migration: add `external_id, earned_value, handed_off_at/note, reconciled_at, done_notified_at, decay_notified_threshold`; backfill `external_id = id`. Backfill Atlas `externalId` from local (one-time script).
2.2 `lib/sync.js`: reconcile (snapshot-replace, safe-abort, transactional, reap-predicate) + outbox (FIFO/quarantine/idempotent/breaker-isolation). + `lib/sync.test.js`.
2.3 Repoint `createItem`/mutations → outbox-on-failure (never null-drop). 
2.4 Deploy; verify first reconcile reaps the 7 ghosts, no nudges on absent tasks, no dup on offline-create.

**Phase 3 — Lifecycle + view (botforge), deploy kristina**
3.1 `lib/lifecycle.js applyTransition` (+ single id resolver, retire dup `findTaskByIdPrefix`, earnedValue compute). + `lib/lifecycle.test.js`.
3.2 Repoint all tools/callbacks (`mark_done, update_task, hand_off, cancel_task, delete_task, create_task`, `callbacks/*`) through `applyTransition`.
3.3 `lib/board-view.js getBoardView`; repoint `board-state`, `query_board`, crons, commands. + `lib/board-view.test.js`.
3.4 Split `notified_at`; fold done-propagation into reconcile (atomic notify-once). 
3.5 Deploy; verify mark-done sets earnedValue, balance bot==dashboard, board shows OVERDUE w/ value.

**Phase 4 — Coherence + crons + alerting (botforge), deploy kristina**
4.1 Proactive senders embed `ID:<cuid8>` + write `message_refs` + history; reply-context consumes `loadMessageRefs`. + test.
4.2 Crons consume `getBoardView`, reconcile-before-destructive, skip-if-stale; `auto-archive` via `applyTransition`. + cron-no-ghost test.
4.3 Alerting in `healthcheck-ping`. 
4.4 Deploy; verify: reply "done" to a nudge resolves by id; cron never acts on absent task; alert fires on simulated stuck circuit.

**Phase 5 — Full verification**
5.1 Run all e2e smokes (C) against prod-like. 5.2 Confirm the original three symptoms are impossible: (i) deleted task → no ghost nudge & brain won't recreate; (ii) nudged task → brain finds & closes it; (iii) handoff → no duplicate. 5.3 Update docs + memory.

---

## E. Open risks accepted / mitigations
- Cross-repo deploy ordering: backend (Phase 1) before bot (Phase 2+) so the bot's new endpoints exist. Each backend change is backward-compatible (additive) so an old bot keeps working between deploys.
- Prod migration: gated on Phase 0 clean status + backup; additive-nullable only.
- Decay compute stays in the bot (no TS port) — single authority preserved via reconcile-computes-earnedValue-once.
