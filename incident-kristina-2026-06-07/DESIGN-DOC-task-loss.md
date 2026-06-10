# Kristina task-loss: root cause + fundamental fix plan

**Date:** 2026-06-07
**Status:** root cause proven. **Phase 0 (stop the bleed) + Phases 1–2 (durable fixes) SHIPPED TO PROD 2026-06-08.** Phases 3–4 (deeper architecture + alerting) remain as documented follow-ups.
**Investigation:** 5-agent team (bot-side lifecycle, Atlas backend, destructive crons, live forensics, outage root-cause).

---

## 0b. Phases 1–2 shipped (2026-06-08)

Deployed to the bot on acemagic via `botforge deploy kristina` (FRAMEWORK_SHA `9dc269a`, health-checked); branch `fix/kristina-task-loss-hardening-2026-06-08`, PR mpavlyukovskyy/botforge#13.

- **`lib/deadline.js` — `normalizeDeadline()` chokepoint** wired into `create_task` + `update_task`: relative durations (`+2h`) parsed to ISO, unparseable values dropped to null. Poison can never enter the pipe again. +`lib/deadline.test.js` (vitest, 57/57 pass).
- **`atlas-client.getItems` local fallback**: when the circuit is open / Atlas errors, serve the local SQLite mirror (shaped like Atlas items, flagged `_stale`) instead of `[]`. The brain's board never goes falsely empty during an outage — kills the "task removed → recreate duplicate" failure at its source.
- **`board-state.js` staleness banner** + **`prompts/kristina.md` rule**: when degraded, the brain must NOT declare a task removed or recreate it.
- Companion Atlas guard `toValidDate` already live on mp-atlas (Phase 0).

**Uber-refund pair decision:** LEFT both copies (May 21 + May 25, 4 days apart — likely two distinct refunds). No deletion = no data loss; Mark can merge them if they're the same.

**Still open (Phases 3–4):** quarantine-after-N-retries in `retrySyncPending`; alert when the circuit stays open > N min (this ran 3 days unnoticed); idempotency keys; soft-delete/tombstones; local SQLite as single source of truth. finance-app hotfix lives on branch `hotfix/kristina-deadline-coercion-2026-06-07` (no `main` in that repo — deploys from feature branches).

---

## 0. Phase 0 outcome (executed 2026-06-08)

- **Deployed** `toValidDate()` guard to mp-atlas (release `deployment-01KTJY8KKP75HN29JYNDB089MC`; rollback = v60 `deployment-01KSF06H9Q96WMG36WB4HVKJCW`). Verified live: the exact poison payload `deadline:"+2h"` now returns **201 with deadline:null** (was 500). Branch `hotfix/kristina-deadline-coercion-2026-06-07`, commit `f4b8ed7` (NOT yet merged to main / PR'd).
- **Cleaned** 3 poison rows in `acemagic:/opt/botforge/data/Kristina-tools.db` (nulled `+2h`/`+0h`). NOTE: first cleanup pass used a bare-`YYYY-MM-DD` GLOB that wrongly nulled a valid ISO datetime on row `1c1b9026` — **restored** immediately.
- **Restarted** `botforge-kristina` to clear the stuck in-memory circuit breaker. Next `sync_retry` synced all **14** stranded rows; unsynced now 0; **zero** 500s/circuit-opens since.
- **De-duped** 4 same-session bug-dupe groups (Dispute restaurant charge 3→1, Call Bogdan now 3→1, Change hotel reservation 2→1, Get the book "Alexander" 2→1), deleting from Atlas + local together, keeping the In-Progress/earliest survivor. **Left** the "Get Uber refund" pair (May 21 vs May 25, 4 days apart — possibly two real refunds) for Mark to judge.

Still TODO for Mark: merge/PR the hotfix to main; decide the Uber-refund pair; Phases 1–4 below.

---

## 1. One-paragraph summary

Kristina is not losing tasks to deletion. A single bad-data payload poisoned the sync
pipe and a blind retry loop has been replaying it every 5 minutes since **Jun 5 11:11 EDT**,
making a healthy backend look like a 3-day outage. The brain's board-read returns an
**empty list** during that failure instead of falling back to the local copy, so the model
sees an empty board, concludes existing tasks "were removed," and recreates duplicates that
*also* never persist. The proximate cause is one poison pill; the reason it became visible
data-loss is three architectural flaws in how the bot reads, retries, and reconciles state.

---

## 2. What actually happened (evidenced)

### The poison pill
- The bot's brain emitted `deadline: "+2h"` / `"+0h"` (relative durations) instead of the
  ISO `YYYY-MM-DD` its own tool schema specifies (`tools/create_task.js:12`).
- Atlas POST handler does `deadline ? new Date(deadline) : null`
  (`finance-app/src/app/api/sync/kristina-bot/items/route.ts:110`).
  `new Date("+2h")` → `Invalid Date` → **`PrismaClientValidationError`** → HTTP 500
  `"Failed to create item"`. The error is thrown *before* any SQL runs — which is why
  **reads keep returning 200** (GET never constructs a Date).
- Real log line from `flyctl logs -a mp-atlas`:
  ```
  POST /api/sync/kristina-bot/items error: PrismaClientValidationError:
  Invalid value for argument `deadline`: Provided Date object is invalid. Expected Date.
  ```
- Three poison rows confirmed in `/opt/botforge/data/Kristina-tools.db`: deadlines `+2h`,
  `+2h`, `+0h`. First created **2026-06-05 11:11 EDT** = outage onset.

### The amplifier
- `cron/sync-retry.js` (every 5 min) calls `retrySyncPending`, which re-POSTs **every**
  `synced_at IS NULL` row — including the 3 poison rows — on every cycle.
- Each cycle: 3 × 500 → circuit breaker opens (3 failures → 15-min backoff,
  `lib/atlas-client.js`). The breaker reopened **53 times today**.
- While the breaker is open, `getItems()` returns `[]` (`atlas-client.js:207-211`) — it does
  **not** fall back to local SQLite (unlike `getColumns()`, which does). New creates return
  null and are "saved locally only," `spok_id=NULL`.

### The visible failure (the screenshot)
1. 17:10 EDT — "Dispute this..." → circuit open → task saved local-only, `spok_id=NULL`.
2. +21s — second create fires → **duplicate** (both rows confirmed, both unsynced).
3. 17:58 EDT — "put in progress" → brain calls `getItems()` → `[]` → concludes
   "appears to have been removed" → offers to recreate. The "removed" wording is the model's
   own prose; **no delete ever occurred**.

### Current blast radius
- **9 tasks stranded** local-only (`spok_id=NULL`): 3 poison (won't sync as-is) + 6 good
  (will sync automatically once the breaker clears).
- DB shows **20+ titles duplicated 2–3×** from this and prior episodes.
- mp-atlas: app healthy, last deploy May 25 (v60), DB up, **not** disk/migration/deploy.

---

## 3. The class of bug — design flaws

Honest separation: **Flaw A caused this incident.** B–D are independent latent causes that
will keep producing loss/duplicates even after the poison pill is gone.

### A. (root) No input validation + a retry loop that replays poison forever
- Bad `deadline` is accepted by the bot, persisted to local SQLite, and re-sent every 5 min
  with no quarantine. One malformed field stalls the entire sync pipe for every task.
- Neither side validates: bot tool schema is advisory only; Atlas trusts `new Date()`.

### B. "Backend unreachable" is silently rendered as "board is empty / task removed"
- `getItems()` collapses *"I can't reach Atlas"* into *"there is nothing there"* with **no
  local fallback** and **no staleness signal** to the brain. The system prompt has zero
  degraded-mode guidance, so the model treats an empty read as truth and recreates.

### C. Two unreconciled sources of truth
- `<board_state>` (what the brain sees) = **live Atlas, OPEN-status only**.
- Every mutation tool = **local SQLite**.
- They agree only when Atlas is healthy AND every local row has a valid `spok_id`. Sync is
  one-directional (bot→Atlas); there is **no Atlas→local reconciliation anywhere**. A
  local-only task is invisible to the brain; an Atlas-only task is unresolvable by every tool.

### D. No idempotency + no soft-delete
- Creates always `INSERT` a fresh UUID — no dedupe-on-title, no external-id/upsert on either
  side. Brain-recreate AND `sync-retry` can both double-post.
- Deletes are hard (no tombstone), so the bot cannot tell "Mark deleted this" from "never
  synced" — absence always reads as "recreate it."

### Latent extras (real, not today's cause)
- **Auto-archive 14-day sweep** (`cron/auto-archive.js:26-35`) flips any OPEN task with a
  >14-day-old deadline to ARCHIVED in Atlas — no notice, no tombstone — and it vanishes.
- **Implicit current-billing-month scoping** on the Atlas GET (`items/route.ts:29`): board
  read is silently pinned to the current month; month-rollover migration carries only OPEN
  items forward, so tasks can blink out at month boundaries.

---

## 4. Fix plan

### Phase 0 — Immediate remediation (stop the bleeding) — NEEDS MARK'S GO-AHEAD
Production write + a deploy + a DB edit on acemagic. Ordered safest-first.

1. **Harden the Atlas handler to coerce bad dates to null** (defensive; the durable input
   guard). In `items/route.ts` POST line 110 and PATCH lines 201-203:
   ```js
   const d = deadline ? new Date(deadline) : null;
   // use: d && !isNaN(d.getTime()) ? d : null
   ```
   Deploy: `flyctl deploy --remote-only` (rollback = redeploy v60 image). **This alone
   restores writes for all current + future bad payloads, including the 3 poison rows.**
2. **Clean the 3 poison rows** so retry stops failing even pre-deploy:
   ```sql
   UPDATE tasks SET deadline = NULL
   WHERE synced_at IS NULL
     AND deadline IS NOT NULL AND deadline != ''
     AND deadline NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
   ```
   on `/opt/botforge/data/Kristina-tools.db`.
3. **De-dupe** the "Dispute restaurant charge" pair (and "Change hotel reservation" pair)
   once writes recover — keep one, delete the other.
4. After #1: the 6 good stranded tasks sync automatically; the 3 ex-poison sync with null
   deadlines. No further manual work.

### Phase 1 — Stop poison from ever stalling the pipe again (core)
- **Validate `deadline` in the bot before send** (`tools/create_task.js`): parse relative
  durations (`+2h`) to an ISO date, or drop to null if it doesn't match `YYYY-MM-DD`.
- **Quarantine, don't infinite-retry** (`retrySyncPending`): cap attempts per row; after N
  failures, mark the row `sync_error` + surface it, so one bad row can't block the queue.
- **Validate at the Atlas boundary** (kept from Phase 0 #1): never let untrusted input reach
  `new Date()`/Prisma raw.

### Phase 2 — Make outages invisible to the user, not catastrophic (core)
- **`getItems()` falls back to local cache when the circuit is open** (mirror `getColumns()`),
  and inject a `⚠ board state may be stale — Atlas unreachable` banner into context.
- **Prompt rule:** never declare a task "removed" or recreate it when the board read failed
  or returned the staleness banner.
- **Idempotency:** bot-owned stable external id on create; Atlas upserts on it so retries /
  recreates can't duplicate. Dedupe-on-title guard before `create_task`.

### Phase 3 — Fix the architecture (fundamental)
- **Make local SQLite the single source of truth; Atlas a replica.** Brain reads the board
  from local state (always has the task it just created); a background reconciler syncs both
  directions. This dissolves Flaws B and C — an outage can never hide a task.
- **Soft-delete + tombstones** on Atlas so "deleted" ≠ "missing"; brain stops recreating
  genuinely-deleted tasks.
- **Fix the latent paths:** auto-archive of *active* tasks requires a real inactivity signal
  + notify Mark + leave a brain-visible tombstone (DONE>24h archive is fine; the OPEN-14-day
  rule is the dangerous one). Make the board query explicit about billing-month.

### Phase 4 — Never go blind for 3 days again
- **Alerting:** `cron/healthcheck-ping.js` should alert (Argus Telegram) when Atlas writes
  fail N times or the circuit stays open > X minutes. This outage ran 3 days unnoticed.

---

## 5. Priority

| Action | Why | When |
|---|---|---|
| Phase 0 (#1 deploy + #2 clean + #3 dedupe) | Actively losing tasks right now | Today, on approval |
| Phase 1 + 2 | Kills the class of bug (poison + blind-empty + dup) | This week |
| Phase 4 alert | Cheap; would have caught this on day 1 | With Phase 1 |
| Phase 3 | Fundamental, larger change | Planned follow-up |

Load-bearing fixes are **Phase 2 (local fallback + no-recreate-on-failure)** and **Phase 3
(single source of truth)**. Everything else is hardening around them.

---

## 6. Key file references
- Bad date accepted → 500: `finance-app/src/app/api/sync/kristina-bot/items/route.ts:110`, `:201-203`
- Poison emitted: `botforge/bots/kristina/tools/create_task.js:12`
- Blind retry replays poison: `botforge/bots/kristina/lib/atlas-client.js` `retrySyncPending` (~390-441), `cron/sync-retry.js`
- Empty-on-circuit-open, no local fallback: `lib/atlas-client.js:207-211`
- Board = live Atlas OPEN only: `context/board-state.js:13-14`
- Auto-archive 14-day sweep: `cron/auto-archive.js:26-35`
- Billing-month scoping: `items/route.ts:29`
- Forensic DB: `acemagic:/opt/botforge/data/Kristina-tools.db`; service `botforge-kristina.service`
