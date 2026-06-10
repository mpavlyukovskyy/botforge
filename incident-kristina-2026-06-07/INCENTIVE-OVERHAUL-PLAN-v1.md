# Incentive overhaul — implementation plan v1 (pre-red-team)

Builds the recommended system across BOTH surfaces: the **Atlas dashboard** (finance-app `mp-atlas`, where Mark works) and the **Telegram bot** (kristina, where Kristina + Sara/Hendrik work). Atlas is the single source of truth (already shipped); the bot reads/writes via the sync API + reconcile.

## The system being built (recap)
Value = `$1 base × priorityTier × decay(full→$0, floored) × qualityGate`. WIP-limited active lane forces completion; Waiting lane (paused clock) for external blocks; long work decomposes into milestones. Endowed monthly pool + clawback (no debt). Quality gated (reopen→$0, excellent→+15%). Tiers are Mark's prioritization lever (weekly P0/P1 budget). Scoreboard not loss-ledger; recognition; progress-based responsiveness.

---

## Data model (Atlas Postgres — the source of truth; bot mirrors via reconcile)

### TaskItem additions (all nullable/defaulted → additive migration)
- `priorityTier String @default("STANDARD")` — ROUTINE | STANDARD | IMPORTANT | P0. Multipliers 0.5/1/3/8 live in code, not DB.
- `lane String @default("TODO")` — TODO | IN_PROGRESS | WAITING | DONE. (Replaces relying on column slug for lifecycle; column becomes display-only within a lane. Keep columnId for board placement; `lane` is the authoritative workflow state.)
- `blockedOn String?`, `blockedAt DateTime?` — Waiting lane: who/what it's blocked on + when (for chase cadence + clock pause).
- `parentTaskId String?` (+ self-relation) — milestone → parent project. `isProject Boolean @default(false)`.
- `qualityState String @default("PENDING")` — PENDING | ACCEPTED | REOPENED | EXCELLENT. Drives quality gate.
- `startedAt DateTime?` — when it entered IN_PROGRESS (for stalled-progress nudge + cycle time).
- `lastProgressAt DateTime?` — last status move / note / progress signal (nudge keys on this, NOT column).
- (existing: `earnedValue`, `deadline`, `handedOffAt`, `deletedAt`, `externalId` from the Atlas-truth work.)

### New tables
- `IncentiveState` (per requester, per billing month): `requester`, `billingMonth`, `poolStart` (endowed full), `poolDrawdown`, `streakDays`, `freezeTokens`, `responsivenessFactor`, `lastStreakDate`. Drives the scoreboard + clawback pool.
- `Recognition`: `taskId`, `requester`, `note`, `createdAt` — Mark's one-tap "thank you / that mattered".
- `PriorityBudget` (per week): `weekStart`, `p0Used`, `p1Used`, caps in config (≤2 P0, ≤6 P1/week).

### Value computation (one shared module, used by bot + dashboard)
`earnedValue(task) = 1.0 × tierMult(priorityTier) × decayFactor(deadline, now, lane, blockedAt) × qualityMult(qualityState)`
- tierMult: ROUTINE .5 / STANDARD 1 / IMPORTANT 3 / P0 8.
- decayFactor: 1.0 until deadline; then linear → 0 over (tier-scaled) working hours; **floored at 0**; **frozen while lane=WAITING or handedOff**.
- qualityMult: REOPENED→0, EXCELLENT→1.15, else 1.

---

## Phase plan (each phase ships to BOTH surfaces + tests + prod verify)

**P1 — Value-model core.** Add the schema fields (migration). Shared `lib/incentive.ts` (dashboard) + `lib/incentive.js` (bot) computing tierMult/decay-floored/qualityMult. Bot: create_task tier arg (default STANDARD); decay floored at $0 (lib/decay.js); earning × tier × qualityGate (markTaskDoneLocally). Dashboard: tier badge display + getTaskBillingStats uses the shared value. Tests: value math table.

**P2 — Lanes + WIP + Waiting/blocked.** Add `lane`, `blockedOn/At`, `startedAt`, `lastProgressAt`. Bot: WIP-limit enforcement (max 3 IN_PROGRESS; refuse to start a 4th); `block_task`/`unblock_task` tools + callback (frees slot, pauses clock, sets blockedOn); chase nudge for WAITING tasks aged > N (keyed on blockedOn + lastProgressAt); rewrite nudge_send/nudge_deductions to key on **lane + lastProgressAt**, not column. Dashboard: render 4 lanes (To Do / In Progress / Waiting / Done), WIP-count indicator, "blocked on" badge + "stuck on me" filter. Tests: WIP enforcement, block frees slot + pauses decay, chase-nudge selection.

**P3 — Quality gate.** `qualityState`. Dashboard: Reopen + Excellent buttons on done tasks (server actions). Bot: reopen → task back to active, earnedValue 0, redo no double-pay; excellent → +15%; reconcile carries qualityState. Tests: reopen zeroes value + no double-pay; excellent multiplier.

**P4 — Prioritization UX + WSJF.** Dashboard: tier selector on create/edit; weekly P0/P1 budget meter (block/ warn when exceeded). Bot: tier in create_task already (P1); WSJF-ranked board_state ("Today's Top 3"); temporary boost. Tests: budget cap enforcement; WSJF ordering.

**P5 — Motivation layer.** `IncentiveState` + `Recognition`. Endowed monthly pool + clawback + streak + freeze + responsiveness factor. Dashboard: scoreboard view (pool, streak, wins, biggest save) replacing loss-ledger; one-tap recognition. Bot: /balance → scoreboard; streak tracking; recognition surfaced. Tests: pool drawdown, streak + freeze, responsiveness factor.

**P6 — Milestones / projects.** `parentTaskId`, `isProject`. Bot: decompose tool (create milestones under a project); milestone completion pays its slice; project shows rollup. Dashboard: project card with milestone progress. Tests: milestone value split, project rollup, only-active-milestone-occupies-slot.

---

## Cross-surface coherence
- All value/lane/quality logic computed from the SAME rules; Atlas is truth, bot reconciles (already built). Dashboard mutations go through server actions; bot via sync API. Both must write `lane`/`qualityState`/`priorityTier` consistently.
- The bot's reconcile must pull + mirror the new fields (extend the snapshot shape + local schema).
- Config (WIP limit, tier mults, budgets, decay hours) in one place per surface, matched.

## Test strategy
- Shared value-math unit tests (both surfaces, same fixtures → parity).
- Bot: WIP, block/unblock, chase-nudge, reopen/excellent earning, streak/pool, milestones (vitest, in-memory sqlite).
- Backend: migration + server actions (reopen/excellent/recognition/budget) — DB-backed where possible, else live E2E via API.
- E2E per phase: create→tier→work→block→done→reopen→excellent across API + verify reconcile + dashboard render.

## Rollout
Atlas (backend) deploys first per phase (additive), then bot. Flag-gate risky behavior changes (WIP enforcement, nudge rewrite) default-off → enable after verify. Each phase reversible.
