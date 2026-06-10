# Kristina incentive system — MASTER build roadmap (one place, the whole thing)

The single consolidated, vetted execution plan. Sequence is the red-team-corrected order. Every phase: build → unit+E2E tests → backend deploy (additive) → bot deploy → verify (information_schema / live E2E) → checkpoint. Behavior changes flag-gated so OFF == today exactly.

## ✅ DONE + LIVE ON PROD (verified)
- **Atlas = source of truth:** reconcile (local cache == Atlas every 5 min), idempotent create (externalId), soft-delete + tombstones. Ghosts reaped; duplicate class killed.
- **Phase 0:** reconcile-first in financial crons (decay/expiry/deductions act on Atlas-equal truth).
- **Phase A:** priority tiers (ROUTINE/STANDARD/IMPORTANT/P0) — Mark-set, clamped Mark-only; WSJF "Today's Top 3"; bot + **dashboard tier badge**. Sequencing signal only (no money change).
- **Liveness:** reconcile alert to Mark on stuck-Atlas / mass-reap. Workflow guides sent.

## REMAINING SEQUENCE (each step is a verified prod ship)

**S1 — Dashboard display-only completion (no money change).**
Make the client board read the bot's frozen `earnedValue` (stop recomputing from `bounty`); replace hand-written field serialization with ONE typed `serializeTaskItem` mapper (so no future field is silently dropped). Closes the live bot↔dashboard money-display divergence. Tests: dashboard persists NO self-computed value; mapper carries all fields.

**S2 — Deductions-reconcile (prerequisite for C).**
Today deductions are one-way bot→Atlas. Extend the deductions endpoint (GET `?all` incl. reversed) + reconcile deductions back to the bot so a dashboard reversal reaches the bot's balance. Tests: reverse-on-dashboard → bot computeBalance drops it.

**S3 — Phase C: procedural justice (improves the live punitive system; trust precondition for money).**
Deduction DMs carry a resolvable `(D:<id>)` handle + batch (no 50-DM spam); `contest_deduction` (owner-or-Mark) flags for Mark; dashboard reverse button (auth-gated server action); `recognize` (Mark-only) + Recognition table. No amounts change. Tests: contest resolves by id + ownership reject; reverse round-trips to bot; recognize Mark-only.

**S4 — Phase D-step1: $0 floor + endowed pool (flag-gated `INCENTIVE_V2`, default OFF).**
Remove negative-debt from decay (rework NOTIFY_THRESHOLDS to age-based; computeBalance overdue-debt→0); endowed monthly pool floored at $0 + clawback + freeze token; per-requester (thread `requester` through computeBalance AND getTaskBillingStats — both lack it today). Flag = an Atlas **config row** (one source: bot crons, bot earning, dashboard stats, client). Backfill writes NEW columns the OFF path never reads. Tests: OFF==today byte-identical; pool never negative; per-requester isolation.

**S5 — Phase D-step2: tier multipliers + quality gate + hasEarned (same flag).**
earnedValue = base × tierMult(0.5/1/3/8) × decay(floored) × qualityMult; shared value module (TS+JS) with a shared JSON fixture both suites assert (parity); `hasEarned`/`firstEarnedAt` so reopen→redo can't re-pay; unify the two completion paths (dashboard done-path computes via the module / lets the bot freeze it); delegation 0.7×. Tests: fixture parity TS==JS, no-double-pay, unified-completion parity.

**S6 — Phase B-full: status-machine + WIP + Waiting/blocked.**
Extend `TaskItemStatus` enum (+IN_PROGRESS, +WAITING) — NO new `lane` axis; rewrite ALL 8 coupling sites (3 server tasks.ts + 3 client task-board.tsx DnD + the 2 cron `column_name='In Progress'` matches); migration + backfill (status from column slug, preserve ARCHIVED; startedAt/lastProgressAt). `block_task`/`unblock_task` (blockedOn enum MARK/INTERNAL/VENDOR; **only blocked-on-MARK pauses the decay clock** — anti park-to-dodge); chase cron (aged WAITING, DMs Mark for blocked-on-Mark, dedup); WIP per-assignee (advisory, never blocks done/unblock); nudge crons exclude WAITING. Tests: coupling parity, backfill sanity, block freeze+exclude, WIP per-assignee, reconcile round-trip all fields, DnD-WIP-reject.

**S7 — Phase D-step3: blocked-interval decay subtraction.**
`computeDecayValue` subtracts `blockedSecondsTotal` so unblock resumes fairly (the only real B-full→D coupling).

**S8 — Phase E: milestones. ✅ SHIPPED (2026-06-10).**
`parentTaskId`/`isProject`/`valueShare` (weight); child earned = parentTieredValue × (share/Σshares) × decay (PARTITION, never multiply); project container earns 0; project rollup in board_state (open-milestone count, containers excluded from Top 3). `decompose` tool (owner-or-Mark). Migration `20260610230000_add_milestones` applied to prod (additive). 133 bot tests green incl. milestone-partition (3x project split into 3 = 3 total not 9; unequal shares proportional; container=0). Flag still OFF.

**S9 — Dashboard full surface. ✅ SHIPPED (2026-06-10).**
Server-side INCENTIVE_V2 read → `incentiveV2` prop. v2 scoreboard (pool/wins/on-time%/biggest win + live WIP gauge, replaces loss-ledger framing); WIP-limit (3) enforced on drag before any optimistic move (visible structured rejection, NOT a silent catch); Mark-only quality lever in the task detail sheet — **Rework** (clears pay + bonus, moves to In Progress; bot reconcile resets the local has_earned latch so a redo re-earns) and **Mark excellent** (idempotent 1.15× bonus, rebases off the un-bonused value so toggling restores base). New `qualityMult` Decimal (additive, default 1.0 = neutral) + `reopenTask`/`markTaskExcellent` server actions (single-user app → requireAuth == Mark). Waiting (S6) + Project (S8) card badges. Bot earning multiplies by quality_mult; reconcile carries it. Migration `20260610234500_add_quality_mult` applied to prod. 140 bot tests green (+7); finance-app tsc clean. Flag still OFF → byte-identical to today.

**S10 — Cutover. ✅ LIVE (2026-06-10).** `INCENTIVE_V2` flipped on in prod `Config` (verified via the bot config API = `{"INCENTIVE_V2":"true"}`; both surfaces read this same source). Bot restarted clean (0 restarts, no errors) and refreshes the flag each reconcile. Pay-model guide sent from the Kristina bot to the group chat (msg 7485). `IncentiveState` has no readers so no seeding needed; flip is one row, instantly reversible (`S10-CUTOVER-RUNBOOK.md`). The money model (floored decay, tier mult, quality mult, milestone partition, no-debt balance) is now the live comp model. **Final natural proof = Kristina's next real completion earns under the new model;** standing liveness = `kristina-probe.sh` + fleet-watchdog.

## Cross-cutting guardrails (apply to every step)
- Every new field → all 8 reconcile sites (bot ensureDb + runMigrations ALTER + sync.js insert/update + fetchAtlasSnapshot + getLocalItems + findTaskByIdPrefix + create/updateItem + board_state) + a round-trip test.
- Mark-only: tier raise, excellent, recognition, reverse-deduction, budget.
- Flag = Atlas config row; backfills write OFF-invisible new columns.
- Per-requester everything; PriorityBudget global-to-Mark; WIP subject = assignee.
- Additive migrations only (nullable/defaulted, lock_timeout); applied in-machine; verified via information_schema. Backup gate (note: MPG on-demand backups currently FAIL — fix before any non-additive migration).

## Definition of done
`INCENTIVE_V2` ON; both surfaces compute identical earnedValue from one module; no negative debt; quality-gated, no double-pay; WIP + Waiting live; milestones partition; deductions contestable; scoreboard not loss-ledger; all per-requester; full test coverage; every phase proven E2E in prod with a standing liveness check.

## Execution stance
This ships **phase by phase to prod, each verified before the next** — that's the correct way to roll a money system onto a live employee's compensation, not a limitation. ~10 verified prod ships. The money behavior is dark (flag OFF) until S10, so the system is "fully built on prod" well before the cutover, and the cutover is a single safe flag flip.
