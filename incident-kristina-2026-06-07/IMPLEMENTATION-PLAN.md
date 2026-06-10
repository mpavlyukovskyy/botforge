# Kristina fundamental fix — Implementation Plan (v1, pre-red-team)

**Date:** 2026-06-09 · **Decision locked:** Atlas = single source of truth; local SQLite = reconciled write-through cache.
**Goal:** eliminate the entire class of "two-brains-disagree" bugs (lost tasks, duplicates, nudged-but-invisible, phantom deductions on deleted tasks) at the root. Not a band-aid.

---

## 1. Invariants the finished system must hold (the acceptance contract)

1. **Existence is single-sourced.** A task exists iff it exists in Atlas (not soft-deleted). Local SQLite never asserts existence Atlas doesn't.
2. **No ghost actions.** No cron (nudge/decay/deduction/expiry/archive) ever acts on a task absent from Atlas.
3. **Coherence.** Anything the bot says proactively about a task, the brain can find and act on in the same turn — by a stable id, not a title match.
4. **One identity.** Every task has one stable id used by the brain, board, tools, crons, and every proactive message.
5. **One lifecycle.** A task's state is computed one way; column / "done" / earned-status never contradict.
6. **Idempotent creates.** A create retried after a lost response never produces a duplicate.
7. **Convergence.** Any edit made on the dashboard (delete, move, archive, deadline, done) is reflected to the bot within one reconcile cycle; any bot edit reaches Atlas or is durably queued.
8. **Offline-safe.** With Atlas unreachable the bot still reads (cache, flagged stale) and still accepts creates (queued, idempotent), and never loses or duplicates on recovery.
9. **Observable.** Drift, stuck circuit, and reconcile reaps are alerted, not silent.
10. **Tested.** Every new component has a test suite asserting the above.

---

## 2. Target architecture

```
 Brain ─┐
 Dash  ─┼──────────►  ATLAS (Postgres)  ── single source of truth
 Crons ─┘                 ▲   │              status + lifecycle + $ state + tombstones
            write-through │   │ reconcile (pull ALL incl. deletedAt)
                          │   ▼
                    local SQLite = cache (never authoritative for existence)
                          │
                    + durable outbox (offline creates/mutations, idempotent)
```

- **Identity:** `externalId` = a bot-minted UUID, created once at task creation, sent on every create attempt; Atlas column `externalId @unique`; create = upsert-on-externalId (idempotent). The Atlas `id` (cuid) remains the canonical id the brain/messages display; `externalId` is the idempotency + offline-reconcile key. Local cache stores both.
- **Lifecycle (one model):** `status ∈ {OPEN, DONE, ARCHIVED, CANCELLED}` is the spine. `earnedStatus ∈ {NULL, OVERDUE, EARNED, LATE, FORFEITED}` is an orthogonal financial sub-state valid only with a deadline. Column is *placement within OPEN* and is never a lifecycle source. "Done" means exactly `status=DONE`. All transitions go through one `applyTransition()` function (bot side) that writes Atlas then the cache.
- **Financial/lifecycle state lives in Atlas:** new columns `earnedStatus` (already exists, formalize), `currentValue`, `handedOffAt`, `handedOffNote`, `deletedAt` (tombstone), `externalId`. Local SQLite mirrors them; nothing is local-only-authoritative.
- **Reconciler (the keystone):** a cron that GETs the full Atlas task set (all statuses, including soft-deleted via `deletedAt`) and makes local match exactly — upsert present, tombstone/remove absent (that were previously synced). Kills ghosts.
- **Outbox:** local creates/mutations made while Atlas is down are written to a durable `outbox` and flushed (idempotently, via externalId) on recovery — replaces the ad-hoc `synced_at IS NULL` retry.
- **One task-view service:** `getBoardView()` used by board_state, query_board, and every cron. Returns the full lifecycle (status, earnedStatus, currentValue, deadline, handoff, column, lastNudge). Reads the reconciled cache (which equals Atlas). Brain context renders overdue/decaying with values, not just OPEN titles.
- **Proactive coherence:** every nudge/digest/expiry message embeds `ID:<cuid8>` and is appended to conversation history (and a message→taskId map) so a reply ("done") resolves by id.
- **Alerting:** circuit-open > N min, reconcile drift/reaps, outbox backlog → Argus Telegram (Mark's existing alert channel).

---

## 3. Concrete changes by component

### A. Atlas backend (finance-app)
- **Schema (`prisma/schema.prisma` `TaskItem`):** add `externalId String? @unique`, `currentValue Decimal?`, `handedOffAt DateTime?`, `handedOffNote String?`, `deletedAt DateTime?`. Confirm `earnedStatus` enum/string. Migration is additive + nullable (safe, no backfill of behavior).
- **POST /items:** accept `externalId`; **upsert on externalId** (create if absent, return existing if present) → idempotent. Keep `toValidDate` guard.
- **DELETE /items:** switch from hard delete to **soft delete** (`deletedAt = now`) so the reconciler can distinguish "deleted" from "never synced" and so dashboard deletes are detectable. (Dashboard `deleteTaskItem` in actions/tasks.ts likewise soft-deletes.)
- **GET /items:** add `?since=` / `?includeDeleted=1` / `?all=1` mode returning every task incl. `deletedAt`, for the reconciler. Fix the implicit `billingMonth=current` scoping: for the bot's board/reconcile reads, do NOT silently drop OPEN tasks from prior months (carry ALL non-archived forward, or drop the month filter on these reads).
- **PATCH /items:** accept + persist `currentValue`, `handedOffAt`, `handedOffNote`, `earnedStatus` (now real columns).

### B. Bot — cache + identity + outbox (`lib/atlas-client.js`, new `lib/sync.js`)
- Local `tasks` schema: ensure `external_id` (= local `id`), `spok_id` (cuid), full mirror of Atlas lifecycle/financial columns, `deleted_at`.
- New **`reconcile(ctx)`**: GET all Atlas tasks; upsert by externalId→spok_id; tombstone local rows synced-but-absent. Returns a drift report.
- New **outbox**: table `outbox(id, op, payload, external_id, attempts, last_error, created_at)`. Create/mutate enqueue; flush sends with externalId (idempotent). Replaces blind `synced_at IS NULL` re-POST.
- `getItems` already has local fallback (shipped) — repoint at the reconciled cache + full-lifecycle shape.

### C. Bot — one transition function (`lib/lifecycle.js`)
- `applyTransition(ctx, taskId, transition)` for {markDone, reopen, archive, cancel, handoff, setDeadline, moveColumn, setDecay}. Writes Atlas (or outbox) then cache. Single place that maintains status/earnedStatus/column coherence. All tools + crons call it. Retires per-tool ad-hoc dual writes, `markTaskDoneLocally` dead code, `notified_at` overload (split into `decay_notified_threshold` + `done_notified_at`).

### D. Bot — task-view service (`context/board-state.js`, `tools/query_board.js`, crons)
- New `getBoardView(ctx, filter)` in `lib/board-view.js`: reads reconciled cache, returns full lifecycle. board_state renders OPEN + OVERDUE/decaying (with $), and never claims removal when stale. query_board + all crons consume it.

### E. Bot — proactive coherence (crons + adapter/skill)
- Every proactive sender embeds `ID:<cuid8>` and writes the sent message into conversation history + a `proactive_refs(msg_id→task_id)` map. Reply-context resolves a reply to its task by id.

### F. Alerting (`cron/healthcheck-ping.js` or new)
- Alert to Argus on: circuit open > 15 min, reconcile reap/drift > 0, outbox backlog > N or age > M.

---

## 4. Data migration / backfill
- Atlas: additive nullable columns — no data rewrite. Backfill `externalId = id` (cuid) for existing rows so reconciler has a key (or treat null-externalId rows as keyed by cuid).
- Local: one reconcile run after deploy converges the cache to Atlas truth (reaps the 7 current ghosts).
- The 7 known orphans: reaped by the first reconcile (P3.1 effect).

## 5. Test strategy (per component, vitest + backend tests)
- `lib/lifecycle.test.js` — every transition: legal/illegal, status×earnedStatus×column coherence, idempotency.
- `lib/sync.test.js` — reconcile: upsert, tombstone-absent, don't-reap-unsynced, drift report; outbox: enqueue/flush/idempotent-on-retry/no-dup.
- `lib/board-view.test.js` — full-lifecycle shape, OVERDUE surfacing, stale flag.
- backend `items.route` tests — upsert-on-externalId idempotency, soft-delete, includeDeleted GET, billing-month fix.
- cron tests — no selection of Atlas-absent tasks; nudge text carries id.
- end-to-end smoke: create→sync→dashboard-delete→reconcile→cron-skips→brain-can't-recreate-ghost.

## 6. Phasing (each shippable + reversible)
- **P3.1** reconciler + outbox + tombstone/soft-delete + notified_at split → kills ghosts. (bot + minimal backend: soft-delete + includeDeleted GET)
- **P3.2** externalId idempotent create (backend + bot outbox uses it).
- **P3.3** move financial/lifecycle fields into Atlas schema; cache mirrors; applyTransition.
- **P3.4** board-view service + brain full-lifecycle context + proactive id/logging.
- **P4** alerting.

Sequence detail + final vetting follow after red-team.
