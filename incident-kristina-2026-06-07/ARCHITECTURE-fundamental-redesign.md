# Kristina: fundamental architecture diagnosis + redesign

**Date:** 2026-06-09
**Status:** first-principles evaluation. NO CODE — this is the structural decision doc.
**Investigation:** 3-agent team (nudge forensics + live evidence, static state-model audit, proactive/conversational coherence) building on the 2026-06-07 incident.
**Companion:** `DESIGN-DOC-task-loss.md` (the poison/outage incident + the Phase 0–2 band-aids already shipped).

---

## 1. The verdict in one sentence

Kristina has **two sources of truth that are never reconciled** — local SQLite (crons + the financial/decay model) and Atlas Postgres (the brain + dashboard) — joined by a stable-identity-less, one-directional, best-effort sync; every observed bug (lost tasks, duplicates, "nudged but can't find it", phantom deductions) is a predictable output of that design, not an edge case.

## 2. Live proof — "Login to HSBC"

| Where | State |
|---|---|
| Local SQLite | `status=OPEN, earned_status=OVERDUE, current_value=-$3.05, deadline=2026-05-27, spok_id=cmpjcmhqo…` |
| Atlas (all statuses) | **absent — 0 hits for that spok_id** |

It was deleted on the Atlas dashboard. Nothing propagates Atlas deletions to local. The local row is an **immortal ghost**: `decay_check` nudges it, `nudge_deductions` has charged real money against ghosts like it, and the brain (Atlas-only) cannot see, find, or close it. **7 such orphans exist right now.**

## 3. The five structural faults

1. **Two sources of truth, no reconciliation.** Crons/financials read local SQLite; brain/dashboard read Atlas. Bridges: a create-retry (local→Atlas) and a DONE-only poll (Atlas→local). Nothing reconciles Atlas deletions, column moves, archives, deadline edits, or earned-status back to local; nothing pushes local decay/handoff to Atlas in a form it can store. Best-effort `try/catch` swallows the second-store write on nearly every op.
2. **No stable cross-store identity.** Local UUID vs Atlas cuid, linked only by `spok_id` set one-way after create. Any half-failure or non-tool edit orphans the task permanently.
3. **No canonical lifecycle state machine.** Lifecycle lives in 3 overlapping axes — `status`, `earned_status`, `column` — that can contradict (`OPEN` + `FORFEITED` + column `Done` at once). "Done" means three different things set by three code paths. Consumers key off different axes and legitimately disagree.
4. **The brain sees a sliver of one store.** Context = OPEN, current-billing-month, Atlas only, 6 fields. Blind to earned_status, current_value, handoffs, deductions, DONE/ARCHIVED history, and every nudge it ever sent. The proactive layer acts on the whole lifecycle from local; the conversational layer sees a filtered slice of Atlas. They cannot agree.
5. **Proactive messages are unresolvable + unremembered.** 5 of 6 cron messages carry no task ID; none are written to conversation history. A reply ("done") arrives as opaque text the brain must title-match against a different datastore — which is why it fails.

Institutionalized rot that proves the model is unmaintained as-is: `notified_at` overloaded (decay-threshold vs done-notified) silently suppresses done-propagation; `markTaskDoneLocally` (the only code that sets `earned_status='EARNED'`) is **dead/uncalled**; handoff fields **don't exist in the Atlas schema**; two balance computations (bot vs dashboard) disagree by construction.

## 4. First principles — what a correct design must guarantee

1. **One source of truth.** Exactly one store is authoritative for a task's existence and full lifecycle. Every other copy is a cache that is reconciled, never independently consulted for "does this task exist / what state is it in."
2. **One identity.** A single task id, minted once, stable across every layer and every message. No second id space.
3. **One lifecycle state machine.** A single canonical state (e.g. `TODO → IN_PROGRESS → DONE`, with `OVERDUE`/`HANDED_OFF`/`CANCELLED`/`ARCHIVED` as explicit states or orthogonal flags defined once). Column, "done", and earned-status are derived from it, not parallel truths. Every transition goes through one function.
4. **One task-view service both layers read.** The brain's context, `query_board`, and all crons call the same `getTaskView()` that returns the full lifecycle (including earned_status, current_value, handoff, last-nudge). What a cron can nudge on is exactly what the brain can see and act on.
5. **Reconciliation is built-in and bidirectional.** Deletions, moves, archives, and edits made anywhere converge — including a tombstone so "deleted" is distinguishable from "never synced." No silent best-effort writes.
6. **Proactive messages are first-class references.** Every nudge embeds the canonical id and is recorded where the next brain turn reads it (conversation history + a message→task link). "done" resolves deterministically by id, never by fuzzy title match.

## 5. Recommended target architecture

**Atlas (Postgres) becomes the single canonical source of truth for the ENTIRE task lifecycle, including the financial/decay state. The bot holds a read-through cache that is write-through on mutation and reconciled (full-state pull, including deletions) every cycle. Crons and the brain both read one task-view that reflects the full lifecycle. One id (Atlas), one state machine.**

Why Atlas-as-truth (not local, not event-sourcing):
- **Humans edit on the Atlas dashboard** (the HSBC delete happened there). The authoritative store must be the one humans mutate directly; making local authoritative would just invert the same drift.
- **It removes the "fields only one side can hold" problem** by extending the Postgres schema to hold earned_status (as a real enum), current_value, handoff, and nudge/deduction state. Once Atlas can represent everything, local is a faithful cache with nothing to lose.
- **Event-sourcing is the theoretically-cleanest (Faults 1–3 all dissolve) but is over-engineering** for a single-user task bot; revisit only if audit/history becomes a product requirement. Noting it so the choice is deliberate.
- **Offline resilience is preserved**: the local cache + the already-shipped stale-banner means the bot still answers during an Atlas outage, but it never treats the cache as authoritative for existence.

### Target shape
- **Schema (Atlas):** add `earnedStatus` enum, `currentValue`, `handedOffAt/Note`, and a `nudge`/`deduction` representation to `TaskItem` (or a 1:1 `TaskFinance` table). Add a soft-delete `deletedAt` (tombstone). One lifecycle enum is the spine; column is derived.
- **Mutations:** every tool/cron mutation is a write-through to Atlas through one transition function; local cache updated from the authoritative response, not in parallel.
- **Reconciliation:** one periodic job pulls the full Atlas task set (all statuses + tombstones) and makes local match exactly — deletions included. This single job kills the ghost class outright.
- **Where crons run:** preferably move decay/nudge/deduction compute server-side in finance-app (one store, no sync at all for them); interim, keep them in the bot but pointed at the reconciled cache + the shared task-view.
- **Brain context:** `board_state` surfaces the full lifecycle (overdue/decaying/handed-off with their values), not just OPEN. Nudges embed the canonical id and are logged to history.

### What this retires
The create-retry hack, the DONE-only poll, `notified_at` overloading, `done_synced`, the dead `markTaskDoneLocally`, the three-axis lifecycle, and every `try/catch`-swallowed second write.

## 6. Migration path (phased, each shippable + reversible)

- **P3.1 — Stop the active bleeding (small, do first):** add the missing reconciliation — a job that pulls Atlas state and reaps/ą flags local rows whose `spok_id` is absent from Atlas (tombstone, stop nudging/deducting them). This alone ends the HSBC ghost class without the full redesign. Also fix the `notified_at` overload and revive earned-status on bot-done.
- **P3.2 — Unify identity + lifecycle:** make Atlas id the only id the brain/messages use; define the one lifecycle state machine; route all transitions through it.
- **P3.3 — Extend Atlas schema to hold all lifecycle/financial state;** make local a pure cache; move (or write-through) the financial fields.
- **P3.4 — One task-view service** consumed by board_state, query_board, and all crons; brain sees the full lifecycle; nudges carry ids + are logged.
- **P3.5 — (optional) move cron compute server-side** so the financial model has zero sync surface.
- **P4 — alerting** (carried over): alert when the circuit stays open > N min / reconciliation finds drift. The 3-day outage and these ghosts both ran unnoticed.

## 7. Decision — LOCKED 2026-06-09
**Mark chose: Atlas = single canonical source of truth; local SQLite = reconciled write-through cache** (§5). Event-sourcing and local-as-truth are off the table. All P3.x work below is now scoped to this model. No code yet — implementation begins on Mark's go-ahead, P3.1 first.

## 8. Concrete plan under the locked decision (no code yet)

**P3.1 — Bleed-stopper (ship first, small, reversible).** A reconciliation pass: pull the full Atlas task set (all statuses), and for every local row whose `spok_id` is absent from Atlas, tombstone it locally (new `reconciled_absent_at`) and exclude it from every cron's selection (decay, nudge, deduction, deadline-expiry). Also: fix the `notified_at` overload (separate decay-threshold from done-notified) and revive `earned_status='EARNED'` on bot-completion. Effect: the 7 live ghosts stop nudging + stop charging money immediately. Does not require schema changes.

**P3.2 — One identity + one lifecycle.** Atlas id becomes the only id used in the brain, board, and every proactive message. Define a single lifecycle state (one enum; column derived from it, not parallel). Route all transitions through one function. Retire the three-axis status/earned_status/column tangle.

**P3.3 — Extend Atlas schema to hold the full lifecycle/financial state** (`earnedStatus` enum, `currentValue`, `handedOffAt/Note`, nudge/deduction representation, `deletedAt` tombstone). Local SQLite becomes a pure cache with nothing it alone can represent. Mutations become write-through to Atlas; cache updated from the authoritative response.

**P3.4 — One task-view service** consumed by `board_state`, `query_board`, and all crons. Brain context surfaces the full lifecycle (overdue/decaying/handed-off + values), not just OPEN. Every nudge embeds the canonical id and is written to conversation history so replies resolve by id, never by title-match. Bidirectional reconciliation (incl. deletes) runs every cycle.

**P3.5 — (optional) move decay/nudge/deduction compute server-side** into finance-app so the financial model has zero sync surface.

**P4 — Alerting** (carried from the prior doc): alert when the circuit stays open > N min OR reconciliation finds drift. Both the 3-day outage and these ghosts ran unnoticed for weeks.

Each phase is independently shippable and reversible. P3.1 is the only one that touches live damage and can go out under the existing patch model.
