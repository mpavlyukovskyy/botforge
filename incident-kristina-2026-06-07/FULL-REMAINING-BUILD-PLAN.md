# Incentive overhaul — full remaining build plan (B-full → C → D → E + dashboard)

Carries ALL prior red-team guardrails (INCENTIVE-OVERHAUL-PLAN-FINAL.md §Non-negotiable corrections + the Phase-0/B-lite red-team). Live today: Phase A (tiers + Top-3, sequencing-only) + Phase 0 (reconcile-first in financial crons). Atlas = source of truth; bot reconciles every 5 min.

## Dependency order (must hold): C (trust) ⟶ B-full (state/WIP/Waiting) ⟶ D (money cutover) ⟶ E (milestones). Dashboard surfaces ship alongside each.
Rationale: procedural justice (C) is the trust precondition the behavioral analysis rated #1 and it improves the CURRENTLY-live punitive system immediately; B-full gives the lifecycle states D's money math needs; D is the money cutover (flag-gated); E builds on D's value model.

---

## PHASE C — Procedural justice (do FIRST: improves the live system now, low risk, money-adjacent-safe)
**Why first:** the deduction system is live and charging Kristina today with no appeal path (the #1 trust-killer). Fixing it now is safe (no amounts change) and is the precondition for any new penalty in D.
- **Atlas schema:** `TaskDeduction` add `reason` (already has?), `contestable Boolean @default(true)`, `contestedAt`, `contestNote`, `reversedAt` (exists). New `Recognition` table (taskId, requester, note, byAdmin, createdAt) — Mark-only.
- **Bot:** `record_deduction` already logs reason + creates a PENALTY card; ADD: every auto-deduction (nudge_deductions) writes a contestable record + DMs Kristina a one-line "why + reply to contest"; a `contest_deduction` tool (any user) that flags it for Mark; a `recognize` tool (Mark-only) that posts a thank-you/+note (no money in C). Prompt vocabulary.
- **Dashboard:** a deductions list with a "reverse" button (Mark) + contested flag; recognition surfaced.
- **Tests:** contest flow (flag → Mark sees → reverse), recognition Mark-only, deduction always logged+reasoned.

## PHASE B-full — status unification + WIP + Waiting/blocked (the risky refactor)
**Per red-team: NO new `lane` axis — extend `TaskItemStatus` enum.**
- **Atlas schema:** extend enum `TaskItemStatus` → add `IN_PROGRESS`, `WAITING`. Add `blockedOn` (enum MARK/INTERNAL/VENDOR), `blockedAt`, `startedAt`, `lastProgressAt`, `blockedSecondsTotal` (for decay-interval subtraction). Migration + **backfill** existing 376: status from column slug (in-progress→IN_PROGRESS, done→DONE, else OPEN), startedAt/lastProgressAt=updatedAt.
- **Rewrite the 6 status⇄column-slug coupling sites** (3 server in tasks.ts: moveTaskItem, updateTaskItem, the done coupling; 3 client in task-board.tsx DnD) to key off `status`; column becomes display/order only. Atomic.
- **Bot:** `block_task(item_id, blockedOn)` / `unblock_task` set status=WAITING + blockedOn/At; reconcile carries ALL new fields (8 sites); nudge_send/nudge_deductions exclude WAITING; chase cron (separate select on aged WAITING, DMs requester + Mark for blocked-on-Mark, dedup via chased_at); `computeDecayValue` subtracts `blockedSecondsTotal` so unblock is fair; WIP = per-assignee count of IN_PROGRESS (advisory, never blocks done/unblock). Auth: block/unblock by admin or task requester/assignee.
- **Dashboard:** 4-lane board (To Do/In Progress/Waiting/Done), WIP indicator (client-enforced before optimistic move; moveTaskItem returns structured rejection; kill silent catch), blocked-on badge + "stuck on me" filter. Typed serialization mapper (stop field-drop).
- **Tests:** status-coupling parity, backfill sanity, block→WAITING freezes + excludes from nudge, unblock subtracts blocked interval, WIP per-assignee, reconcile round-trip of all new fields, DnD-WIP-rejection.

## PHASE D — Money cutover (ONE flag-gated, default-OFF, announced move)
Gated behind `INCENTIVE_V2` flag (default off). Ships dark; enabled only after A/B/C verified + announced.
- **Shared value module** (TS `lib/incentive.ts` + JS `lib/incentive.js`) with a SHARED JSON fixture both vitest suites load (parity). `earnedValue = 1 × tierMult(0.5/1/3/8) × decayFactor(floored 0, blocked-subtracted, tier-steepness) × qualityMult(reopen 0 / excellent 1.15 / else 1)`.
- **$0 floor everywhere:** remove negative from computeDecayValue; rework `NOTIFY_THRESHOLDS` to age/lane-based; `computeBalance` overdue-debt → 0 (no debt). **Atlas:** `IncentiveState(requester, billingMonth, poolStart, poolDrawdown, streakDays, freezeTokens, responsivenessFactor)` — pool floors at $0. **hasEarned/firstEarnedAt** flag → reopen→redo can't re-pay.
- **Unify the two completion paths:** dashboard moveTaskItem/updateTaskItem done-path computes earnedValue via the shared module (not raw earnedStatus=EARNED). Atlas owns frozen earnedValue; bot computes once at done.
- **Per-requester everything:** computeBalance + scoreboard + streak + responsiveness filter by requester (today computeBalance has NO filter). PriorityBudget global-to-Mark.
- **base+pool split:** ~70% base + 30% pool (config); dollar = scoreboard. **Delegation 0.7×.** **Quality:** reopen/excellent Mark-only (dashboard buttons + bot); rework-liability (fix before new paid work); clawback window.
- **Dashboard scoreboard** (replaces loss-ledger): pool (endowed, drawn-down framing), streak, wins, biggest save, recognition. Reopen/Excellent buttons.
- **Tests:** value fixture parity (TS==JS), $0 floor, pool-floor (bad month never negative), hasEarned no-double-pay, unified-completion parity (dashboard==bot), streak-on-weighted-value, per-requester isolation, clawback.

## PHASE E — Milestones
- **Atlas:** `parentTaskId` (self-rel), `isProject`, `valueShare` (partition weight). Migration.
- **Bot:** `decompose(item_id, [milestones])` → creates child tasks whose `valueShare` PARTITIONS the parent's tiered value (sum = parent, NOT multiply); ≤1 active milestone per parent occupies a WIP slot; project rollup in board_state. **Tests:** decompose-doesn't-multiply, rollup, 1-active-per-parent.

## Cross-cutting
- Every new field → all 8 reconcile sites + round-trip test (bot ensureDb CREATE + runMigrations ALTER + sync.js insert/update + fetchAtlasSnapshot + getLocalItems + findTaskByIdPrefix + create/updateItem payloads + board_state).
- Each backend phase deploys first (additive), then bot; backfill in the migration; flag-gate behavior changes default-off; verify E2E + information_schema after each.
- Mark-only gates: tier raise (done), excellent, recognition, reverse-deduction.

## CORRECTED SEQUENCE (after 2nd red-team — supersedes the order above)
The 2nd red-team proved B-full is NOT a prerequisite for D's core money math (only blocked-decay needs it), the negative-debt tail is the actively-harmful part, and the dashboard already diverges on money (never reads earnedValue). New order:
**0. Dashboard display-only keystone (THIS TURN):** dashboard reads Atlas-frozen `earnedValue` + `priorityTier`; stops computing money from `bounty`; surfaces a tier badge. Typed serialization mapper so new fields can't be silently dropped. Fixes a LIVE divergence + completes Phase A's dashboard surface. Additive/display — safe.
**1. C (procedural justice) — REQUIRES deductions-reconcile first** (rt-phaseC blocker): deductions are one-way bot→Atlas; reconcile only handles tasks → a dashboard reverse never reaches the bot's balance. Must extend the deductions endpoint (GET ?all incl. reversed) + reconcile deductions back to the bot, give the deduction DM a resolvable `(D:<id>)` handle, scope contest to owner-or-Mark, batch the DMs, and auth-gate the dashboard server actions (they're currently ungated on a publicly-routable page).
**2. D-step-1: $0 floor + endowed pool (flag-gated, default-OFF).** Smallest safe money ship; removes the harmful debt mechanic. Flag = an Atlas CONFIG ROW (one source across both processes + client), NOT env-per-process. Backfill writes to NEW columns the OFF path never reads (backfills don't respect flags — the #1 leak).
**3. D-step-2: tier multiplier + quality gate + hasEarned (same flag).**
**4. B-full: status-enum unify (OPEN/DONE/ARCHIVED +IN_PROGRESS/WAITING) + WIP + Waiting.** 8 coupling sites (the 6 + the 2 cron `column_name='In Progress'` matches in nudge-send/nudge-deductions). Typed mapper prerequisite (from step 0). Only blocked-on-MARK pauses the decay clock (anti park-to-dodge).
**5. D-step-3: wire blockedSecondsTotal into decay (the only real B-full→D coupling).**
**6. E: milestones** — valueShare as a weight, child = parentTieredValue × (share/Σshares) × decay × quality; re-normalize on add.
Per-requester isolation (D): `computeBalance` AND `getTaskBillingStats` both lack a requester filter today — thread `requester` through both, pool/streak/scoreboard per-(requester,month), PriorityBudget global-to-Mark, WIP subject = assignee (backfill assignee).

## This-turn build target
**Step 0 — the dashboard display-only keystone** (read priorityTier + earnedValue, tier badge, typed mapper), to prod, verified. It fixes a live money-display divergence, completes Phase A's dashboard surface, and is the prerequisite for the whole money phase. The rest (C-with-deductions-reconcile, D steps, B-full, E) is the multi-week core, built+verified phase by phase — NOT slammed onto live comp under-verified, per every red-team this session.
