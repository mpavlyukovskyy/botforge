# Incentive overhaul — FINAL vetted plan (post 3-agent red-team)

Supersedes v1. Folds in every red-team finding (data/dashboard, bot/value, coherence/gaming). The headline correction: **sequence the money model behind its safety layer; ship the prioritization lever first with zero earnings change.**

## Non-negotiable corrections from red-team (apply throughout)
- **No new `lane` axis.** Extend `TaskItemStatus` enum with `IN_PROGRESS` + `WAITING`; **status is the single workflow axis**; column becomes display/order only. Rewrite the 6 status⇄column-slug coupling sites (3 server in `tasks.ts`, 3 client in `task-board.tsx`) + the bot's `column_name='In Progress'` nudge match to key off status. (Avoids the 3-axis tangle that caused prior task-loss.)
- **Reconcile is a hand-written overwriter.** Every new field must be added in ONE change to all ~8 sites: bot `ensureDb` CREATE + `runMigrations` ALTER (idempotent try/catch), `sync.js` insert/updateRow, `fetchAtlasSnapshot` shape, `getLocalItems`, `findTaskByIdPrefix`, createItem/updateItem payloads, `board_state`. Plus a reconcile round-trip test. Define per-field **authority**: tier/quality/recognition = Mark/Atlas-authoritative; status/blockedOn/startedAt/lastProgressAt = bot-authoritative (reconcile must NOT clobber a row with `done_synced=0`, and must NEVER stamp `lastProgressAt`).
- **Per-requester everything.** `computeBalance` (today has NO requester filter — conflates Kristina/Sara/Hendrik), scoreboard, streak, WIP count, responsiveness all filter by requester/assignee. WIP subject = the **doer (assignee)**, not requester. Backfill assignee.
- **Authority gates:** tier on `create_task` clamps to STANDARD unless caller is Mark (chatId 381823289); raising tier = Mark-only (like deadline). `excellent`/recognition = Mark/dashboard-only, never assistant tools. Weekly P0/P1 budget is **global to Mark** (his attention is the scarce resource) — stated, not accidental.
- **Money safety (when the money phase lands):** floor decay at $0 AND ship pool-drawdown in the SAME phase (flooring alone guts the `NOTIFY_THRESHOLDS` negatives + `computeBalance` overdue-debt math); pool floors at $0 (never debt); add `hasEarned`/`firstEarnedAt` so reopen→redo can't re-pay; unify the two completion paths (dashboard `moveTaskItem`/`updateTaskItem` must compute value via the shared module, not set raw `earnedStatus='EARNED'`); milestone slices PARTITION the parent's tiered value (don't multiply); parity enforced by a shared JSON fixture both vitest suites load (Atlas owns frozen `earnedValue`, dashboard only displays it).
- **Restore dropped essentials:** procedural-justice layer (contestable/appealable, logged, reasoned deductions; no mid-period rule changes), rework-liability, quality-clawback, delegation pays < completion, base+pool split, focus-block exemption + no-cliff + P0-uncapped on responsiveness.
- **Prerequisite (Phase 0):** the un-shipped DR-7 — reconcile() as first awaited step in every financial/destructive cron + abort-if-stale — MUST land before any tier-weighted money math. And re-confirm prod migrate-status.
- **Migration backfill** of the ~372 live tasks every phase (status from column slug; `startedAt`/`lastProgressAt`=updatedAt; existing DONE → `qualityState=ACCEPTED`; tier=STANDARD).
- **Dashboard reality:** `task-board.tsx` is ~1300 lines with hand-written field serialization that silently drops new fields; replace cast-based plucking with a typed mapper; WIP must be enforced client-side before the optimistic drag + `moveTaskItem` returns a structured rejection (kill the silent catch).

## Corrected phase sequence (each: both surfaces + tests + prod verify + reversible/flag-gated)

**PHASE A — Prioritization lever, ZERO earnings change (the safe first ship — BUILD NOW).**
- Atlas: add `priorityTier String @default("STANDARD")` (additive; backfill existing → STANDARD). New `PriorityBudget` (global-to-Mark, weekly, ET Mon-anchored) — informational meter.
- Dashboard: tier selector on create/edit; tier badge on cards; weekly P0/P1 budget meter (warn at cap).
- Bot: `create_task` accepts `tier`, **clamps non-Mark to STANDARD**; `update_task` can set tier (Mark-only); `board_state` renders tier + a **WSJF-ranked "Today's Top 3"** (value-proxy by tier + deadline urgency ÷ nothing-yet) within the char budget; prompt vocabulary for tiers + Top-3.
- Reconcile: carry `priorityTier` through all 8 sites + round-trip test.
- **Tier is a PRIORITY SIGNAL ONLY — no multiplier on earnedValue yet.** So balances don't move; no money shock; can't re-open the incident class.
- Tests: tier-clamp (non-Mark→STANDARD), WSJF ordering, reconcile round-trip, budget cap meter, backfill sanity.

**PHASE B — Status-axis unification + Waiting lane + WIP (workflow, still no money change).**
- Extend status enum IN_PROGRESS/WAITING; migrate the 6 coupling sites; backfill status from columns. `blockedOn` (enum MARK/INTERNAL/VENDOR) + `blockedAt` + `startedAt` + `lastProgressAt`.
- Bot: WIP limit (per-assignee, advisory, lane/status-keyed, never blocks done/unblock); `block_task`/`unblock_task` (named blocker required; pauses clock); chase nudge for aged WAITING regardless of blocker text, DMs Mark for blocked-on-Mark; rewrite nudge_send/deductions to key on status + lastProgressAt (written only by genuine progress mutators).
- Dashboard: 4-lane board, WIP indicator (client-enforced before optimistic move), blocked-on badge + "stuck on me" filter.
- Tests: WIP per-assignee, block frees slot + pauses decay-clock, chase selection, lastProgressAt writers, nudge no-longer-suppressed-by-reconcile.

**PHASE C — Procedural-justice layer (TRUST PRECONDITION — before any new penalty/money).**
- `record_deduction` → logged, reasoned, **contestable** (appeal-to-Mark path + Telegram message path); symmetric bonus/recognition card; transparency on every adjustment; no mid-period rule changes. `Recognition` table (Mark-only).

**PHASE D — Money cutover (ONE coherent, flag-gated, announced move — after A/B/C + Phase 0/DR-7).**
- Shared value module (TS+JS, shared fixture). Tier *multipliers* + $0-floored decay (with `NOTIFY_THRESHOLDS` reworked to age-based) + QualityGate (reopen→0 + `hasEarned` no-double-pay + rework-liability + clawback) + base/pool split + endowed pool floored-at-$0 + streak(on weighted value)/freeze + responsiveness factor (focus-exempt, no cliff, P0-uncapped) + delegation 0.7×. Unify both completion paths through the module. Scoreboard replaces loss-ledger. Migrate DONE→ACCEPTED.

**PHASE E — Milestones/projects.** `parentTaskId`/`isProject`; milestone value = partition of parent tiered value; ≤1 active milestone per parent occupies a slot; project rollup.

## Second red-team (focused self-review of the Phase-A first ship)
- *Is Phase A truly money-neutral?* Yes — tier is stored + displayed + used for sequencing only; `earnedValue`/`computeBalance` untouched. Verified: no multiplier applied. ✓
- *Self-assign hole?* Closed by clamping non-Mark create to STANDARD + Mark-only raise. ✓
- *Reconcile clobber?* Closed by adding priorityTier to all 8 hand-written sites + round-trip test. ✓
- *Backfill?* Existing 372 → STANDARD is correct (they had no tier); no behavior change. ✓
- *Budget global-vs-per-assistant?* Global-to-Mark, informational only in A (no enforcement that could block work). ✓
- *Dashboard field-drop?* Add priorityTier to the typed serialization sites (TaskItemData interface, page serialize, board handleAddTask + optimistic merges). ✓
- *Residual risk:* WSJF ranking in board_state must stay within the 3000-char context budget → render Top-3 + counts, not all tasks. Mitigated in build.
- Verdict: Phase A is additive, money-neutral, reversible, and independently valuable. Safe to build now.

## Test strategy (per component)
Phase A: `incentive-tier.test.js` (bot — clamp, WSJF order, budget), reconcile round-trip test, dashboard tier-serialization (typed mapper). Later phases: shared value-fixture parity, WIP/block/chase, reopen-no-double-pay, pool-floor, milestone-partition, contestable-deduction.
