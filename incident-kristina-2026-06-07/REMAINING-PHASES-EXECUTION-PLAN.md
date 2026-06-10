# Incentive overhaul — remaining-phases execution plan

Builds on Phase A (priority tiers, LIVE). Carries forward ALL findings from the prior 3-agent red-team (see INCENTIVE-OVERHAUL-PLAN-FINAL.md §"Non-negotiable corrections"). This plan sequences the rest and marks what is buildable+verifiable now vs. flag-gated/sequenced.

## Guardrails carried from the prior red-team (apply to every phase)
- **No new `lane` axis** — when status-unification is needed, extend `TaskItemStatus` enum; rewrite the 6 status⇄column-slug coupling sites atomically.
- **Reconcile is a hand-written 8-site overwriter** — every new field added to ALL of: bot `ensureDb` CREATE + `runMigrations` ALTER, `sync.js` insert/updateRow, `fetchAtlasSnapshot`, `getLocalItems`, `findTaskByIdPrefix`, createItem/updateItem payloads, `board_state`; + round-trip test. Per-field authority defined; never clobber `done_synced=0`.
- **Per-requester everything** (`computeBalance` has NO requester filter today). WIP subject = doer (assignee).
- **Mark-only gates:** tier raise, excellent/+15%, recognition. Assistants clamp to STANDARD.
- **Money safety (Phase D):** floor decay at $0 AND ship pool together (flooring alone guts NOTIFY_THRESHOLDS + overdue-debt math); pool floors $0; `hasEarned` flag for no-double-pay; unify the two completion paths through the shared value module; milestone slices PARTITION parent value; parity via shared fixture.
- **Procedural justice (Phase C) is a trust precondition** before any new penalty/money: contestable, logged, reasoned deductions + appeal path.
- **D is ONE flag-gated, default-OFF cutover** — never slammed onto live comp mid-period.

## Corrected sequence (safe → risky)

**PHASE 0 — reconcile-first in financial crons (BUILD NOW — safety prerequisite, money-neutral).**
The financial/destructive crons (decay-check, deadline-expiry, nudge-deductions) currently rely on the presence-guard, not full reconcile. Add: `await reconcile(ctx)` as the first step; if it aborts (Atlas unverifiable), skip the run. Makes every cron act on Atlas-equal truth. Tests: cron skips on reconcile-abort; cron acts after clean reconcile.

**PHASE B-lite — Waiting/blocked + chase (BUILD NOW — money-neutral, reuses handoff-freeze).**
Add `block_task(item_id, blocked_on)` + `unblock_task(item_id)` tools: block sets `handed_off_at=now` + `handed_off_note="blocked: <who>"` (existing freeze: decay-check & deadline-expiry already exclude `handed_off_at IS NULL`, so the clock + nudges pause) and stores the blocker; unblock clears them and resumes. Chase: decay-check (or a small addition) DMs the requester for tasks blocked > N working hours ("still waiting on X — chased?"), and surfaces blocked-on-Mark to Mark. Prompt vocabulary: "I'm waiting on the vendor" → block_task. Tests: block freezes + excludes from nudge; unblock resumes; chase selection. (Full status-enum WAITING lane + WIP enforcement deferred to Phase B-full.)

**PHASE B-full — status-axis unification + WIP (SEQUENCED, not this turn).** Extend status enum IN_PROGRESS/WAITING; migrate 6 coupling sites + dashboard DnD; WIP per-assignee. Large refactor; needs its own careful build.

**PHASE C — procedural justice (SEQUENCED).** `record_deduction` → logged/reasoned/contestable + appeal-to-Mark path; symmetric recognition card (Mark-only). Trust precondition for D.

**PHASE D — money cutover (SEQUENCED, flag-gated default-OFF).** Shared value module (tier mult × $0-floored decay × quality gate), endowed pool floored-$0 + clawback + base/pool split, streak/freeze on weighted value, responsiveness factor, delegation 0.7×, unify both completion paths, scoreboard. Reopen/excellent (Mark-only) + `hasEarned`. One announced cutover.

**PHASE E — milestones (SEQUENCED).** parentTaskId/isProject; slices partition parent tiered value; ≤1 active milestone per parent.

**DASHBOARD (SEQUENCED).** Tier badge (small, field exists) → lanes/WIP/Waiting → reopen/excellent buttons → scoreboard → budget meter. Big rewrite of the 1300-line board; typed serialization mapper to stop field-drop.

## This-turn build target — REVISED after 2nd red-team
**Phase 0 only** (reconcile-first in financial crons, done correctly) + the two workflow guides (tiers + Top-3, accurate to live state), sent to the "Kristina" group.
**B-lite PULLED from this turn.** The red-team proved it is NOT money-neutral and has gaming holes: (D2) nudge_send/nudge_deductions don't exclude handed-off tasks → a "blocked" task in In-Progress still gets the $0.10 deduction; (D5) block-then-complete locks in $1 via the handoff freeze in markTaskDoneLocally; (D6) unblock resumes decay without subtracting the blocked interval (unfair); (D1) handed_off_at/note aren't carried by reconcile's 8 sites so block silently drops. Doing block/waiting RIGHT needs a separate `blocked_at/blocked_on` column + nudge exclusion + chase cron + auth + blocked-interval subtraction — i.e. it IS Phase B-full. So sequence it there, don't ship a holed version onto a system that still charges real money.

### Phase 0 — corrected build (per red-team D3/D4)
In decay-check, deadline-expiry, nudge-deductions: `const rep = await reconcile(ctx); if (rep?.aborted) { log.warn; return; }` as the FIRST step. Do NOT treat `skipped` (already-running/disabled) as abort — fall through to the EXISTING presence guard (keep it as backstop; reconcile-once + presence is belt-and-suspenders). Tests: skip on aborted, proceed-to-presence on skipped, act on clean.

### Guides — corrected constraints (per red-team)
- Describe ONLY live features: priority tiers (Mark-set, sequencing-only) + "Today's Top 3". NO money/pay changes (old debt + $0.10 deductions still live — don't claim otherwise), NO block/waiting (not built), NO roadmap in Kristina's.
- Tier = ORDER of work, not pay. State explicitly.
- Kristina's guide: present-tense, workflow-only, warm, short. Mark's guide: candid, live-vs-sequenced split.
- Send: chat -5231435029 ("Kristina") ONLY; PLAIN TEXT (adapter doesn't split/fallback); each < 4096 chars; sequential, check `ok:true`; framed "Mark asked me to share…".

## Test strategy (this turn)
- Phase 0: cron-reconcile-first (skip-on-abort, act-on-clean) — vitest with mocked reconcile.
- Block/unblock: freeze + nudge-exclusion + unblock-resume + chase-selection — vitest in-memory sqlite.
- Reconcile round-trip already covers field survival; block uses existing handed_off_at (already in reconcile? verify — if not, add to the 8 sites).
