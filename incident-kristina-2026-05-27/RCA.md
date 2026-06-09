# Incident RCA: Kristina credit-balance outage — 2026-05-27

## Summary

Kristina sent users the generic `⚠️ Failed to process (ref XXXX). Logged for review.` message 4 times today instead of an honest explanation, because the Anthropic account credit balance was depleted and all brain queries failed. Three compounding failures let this happen silently:

1. **Trigger:** Anthropic credit balance exhausted. Every brain call returns `"Credit balance is too low"`.
2. **Stale dist:** The deployed `packages/core` bundle (`chunk-N5VWYLU5.js`, md5 `e02ed6544189034f887fbb61a6c323de`) was built from commit `29aba8f` (2026-05-25). That commit's `classifyError()` has no `credit_balance` case — the error falls through to `unknown` → generic message. The `credit_balance` regex was written later as an uncommitted working-tree change on branch `fix/comprehensive-error-classification`, never built into dist, never deployed.
3. **Notify gap:** `maybeNotifyAdmin()` in the deployed bundle only alerts on `usage_limit` and `auth` (`if (errorClass !== "usage_limit" && errorClass !== "auth") return;`). Even if the new source were deployed, `credit_balance` is still not in the notify allowlist — so no admin ping would have fired anyway.

---

## Timeline

All timestamps local (EDT, UTC-4 unless noted).

| Time (EDT) | Event |
|---|---|
| 2026-05-25 16:35 | Commit `29aba8f` (`fix(core): honest, cause-specific brain error messages`) merged to main. At this point `classifyError` handles: `usage_limit`, `rate_limited`, `auth`, `brain_timeout`, `tool_error`, `unknown`. No `credit_balance` case. |
| 2026-05-25 16:35 | Remote dist built and deployed (`/opt/botforge/packages/core/dist/chunk-N5VWYLU5.js` mtime = 2026-05-25T20:35 UTC). FRAMEWORK_SHA stamped as `29aba8fc`. Services restarted. |
| Some time after 2026-05-25 | `credit_balance` regex added to `packages/core/src/error-messages.ts` as a working-tree edit on branch `fix/comprehensive-error-classification`. Never committed. Never built. Never deployed. |
| 2026-05-27 00:00:36 EDT (04:00 UTC) | **FIRST credit-balance brain error.** `"Brain error [class=unknown ref=ddsu8e65]: Brain query failed: Claude Code returned an error result: Credit balance is too low"`. User receives `"⚠️ Failed to process (ref ddsu8e65). Logged for review."` |
| 2026-05-27 07:46:33 EDT | Second credit-balance error, ref `gdwbf65k`. Generic message sent. |
| 2026-05-27 ~07:50 | Local dist rebuilt (all chunk mtimes updated to 07:50 May 27). Produces identical md5 `e02ed6544189034f887fbb61a6c323de` — rebuild was run from the committed source state `29aba8f`, not from the working-tree additions. Dist NOT deployed to acemagic. |
| 2026-05-27 10:23:25 EDT | Third credit-balance error, ref `bn5svwn4`. Generic message sent. |
| 2026-05-27 18:12:14 EDT | Fourth credit-balance error, ref `cms6h8em`. Generic message sent. |
| 2026-05-27 (this report) | Outage duration still ongoing. Credit balance has not been replenished as of report time. |

**Total confirmed user-facing failures:** 4 brain errors, 4 generic `"Failed to process"` messages sent.
**No admin alert was sent** at any point.

---

## Root Cause — 3 Layers

### Layer 1: Trigger — Anthropic credit balance exhausted

**Confirmed.** All 4 journal errors read identically:
```
Brain error [class=unknown ref=<X>]: Brain query failed: Claude Code returned an error result: Credit balance is too low
```
This is the Anthropic API returning HTTP 400 with `"Credit balance is too low"` on every brain invocation. Cron jobs (which never call the brain) continued normally throughout — there is no crash, no restart, service is fully alive.

Prior incident context: on 2026-05-25 the same service was hit by the *monthly spend cap* (`usage_limit`), which was resolved by raising the cap. Today's error is the distinct `"Credit balance is too low"` string, which Anthropic uses when the prepaid credit balance (separate from spend caps) is zero. The two billing failure modes produce different strings.

### Layer 2: Stale dist — `credit_balance` regex never deployed

**Confirmed.** Three independent evidence points:

**a. The deployed chunk does not contain the `credit_balance` regex.**

Remote acemagic:
```
grep 'credit balance' /opt/botforge/packages/core/dist/chunk-N5VWYLU5.js
# (no output)
```
Local dist (same file):
```
grep 'credit balance' /Users/Mark/Documents/dev/botforge/packages/core/dist/chunk-N5VWYLU5.js
# (no output)
```
Both produce no output.

**b. The md5 hashes match across local and remote — they are the same stale build.**
```
local:  e02ed6544189034f887fbb61a6c323de
remote: e02ed6544189034f887fbb61a6c323de
```
The remote dist was built at 2026-05-25T20:35 UTC (same second as commit `29aba8f`).

**c. The `credit_balance` addition is uncommitted working-tree state only.**

`git status` on branch `fix/comprehensive-error-classification`:
```
modified: packages/core/src/error-messages.ts
```
`git log --all -- packages/core/src/error-messages.ts` shows only one commit: `29aba8f` (2026-05-25). The comprehensive expansion (adding `credit_balance`, `payment_required`, `permission`, `overloaded`, `context_too_long`, `server_error`, `network`, `db_error`, `cli_failure`) was never committed. A local rebuild at 07:50 today produced the same md5 because it compiled from the committed source, not the working-tree additions.

**d. The deployed dist `classifyError()` has no `credit_balance` case.**

The full classification chain in `/opt/botforge/packages/core/dist/chunk-N5VWYLU5.js` (verified by grep):
```js
if (/specified API usage limits/i.test(msg) || /usage limit/i.test(msg)) return "usage_limit";
if (/\b(429|529)\b/.test(msg) || /rate.?limit/i.test(msg)) return "rate_limited";
if (/\b401\b/.test(msg) || ...) return "auth";
if (name === "AbortError" || ...) return "brain_timeout";
if (/timed out/i.test(msg) || ...) return "brain_timeout";
if (/\btool\b|MCP/i.test(msg)) return "tool_error";
return "unknown";   // <-- "Credit balance is too low" lands here
```

`"Credit balance is too low"` matches none of the above → falls to `"unknown"` → `renderError("unknown")` returns the generic `"⚠️ Failed to process (ref X). Logged for review."` message.

### Layer 3: Notify gap — `credit_balance` not in `maybeNotifyAdmin` allowlist

**Confirmed.** The deployed dist at line 46 of `chunk-N5VWYLU5.js`:
```js
if (errorClass !== "usage_limit" && errorClass !== "auth") return;
```
Only `usage_limit` and `auth` trigger an admin alert. Even if `credit_balance` classification were working, `maybeNotifyAdmin` would have returned early without paging anyone.

This gap exists in **both** the deployed dist and the current uncommitted source (`packages/core/src/error-messages.ts` line 156):
```ts
if (errorClass !== 'usage_limit' && errorClass !== 'auth') return;
```
The source improvement added `credit_balance` to `classifyError` and `renderError` but did not add it (or `payment_required`) to the `maybeNotifyAdmin` allowlist. So the notify gap is a source-level defect that will persist even after the dist is rebuilt and deployed.

---

## Blast Radius

**Active services sharing the stale core bundle:**

| Service | Status | Exposed? |
|---|---|---|
| `botforge-kristina` | active (running since 2026-05-25) | Yes — confirmed affected today |
| `botforge-trainer` | active (running since 2026-05-25) | Yes — same stale `chunk-N5VWYLU5.js` |
| `botforge-chief-of-staff` | active (running since 2026-05-25) | Yes — same stale `chunk-N5VWYLU5.js` |
| `botforge-hali99` | active (running since 2026-05-25) | Yes — same stale `chunk-N5VWYLU5.js` |

All four bots load `packages/core` at start from `/opt/botforge/packages/core/dist/`. They share a single copy of the dist. There is one `FRAMEWORK_SHA` file stamped `29aba8fc`.

Trainer and chief-of-staff showed no credit-balance errors today (journal clean), but only because they apparently received no user messages that triggered a brain call during the outage window — not because they have any immunity.

**Inactive services** (alfred, atlas, harry, maia): systemd service files exist but units are disabled/dead. Not affected.

---

## Why Monitoring Did Not Catch It

1. **No `credit_balance` admin ping:** `maybeNotifyAdmin` only fires on `usage_limit` and `auth`. Since the error was misclassified as `unknown`, the notify path was not even reached.

2. **No admin ping for `unknown` class:** There is no catch-all alert for recurring `unknown` errors. A burst of `unknown` brain failures is indistinguishable from ordinary noise without active log scraping.

3. **No external health check:** No cron or external watchdog monitors journal error rates or hits a health endpoint. The `healthcheck_ping` cron job visible in the logs is a bot-internal ping; it does not call the brain and does not inspect error counts.

4. **Generic user message:** Users saw `"⚠️ Failed to process (ref X). Logged for review."` — identical wording to every other `unknown` error. There is no escalation path from user-visible ref to admin alert.

5. **No billing webhook:** No Anthropic webhook or polling job monitors credit balance. The first signal is a failed brain call, not a low-balance warning.

---

## Confirmed Facts vs Unverified Claims

### Confirmed (grepped/read/md5'd)

- Journal shows 4 `"Credit balance is too low"` brain errors at 00:00, 07:46, 10:23, 18:12 EDT on 2026-05-27.
- First error today: 2026-05-27T04:00:36 UTC (00:00:36 EDT), ref `ddsu8e65`.
- Error class in all 4 journal entries: `class=unknown` — proving the classification failure.
- Remote chunk `/opt/botforge/packages/core/dist/chunk-N5VWYLU5.js` md5: `e02ed6544189034f887fbb61a6c323de`. Contains no `credit balance` regex.
- Local dist chunk md5: `e02ed6544189034f887fbb61a6c323de` (identical to remote).
- FRAMEWORK_SHA on acemagic: `29aba8fc41c01ed2edce004a9a48c0ea63a827bb` — matches commit `29aba8f`.
- Commit `29aba8f` (2026-05-25T20:35 UTC) is the only git commit that ever touched `packages/core/src/error-messages.ts`.
- The `credit_balance` regex (`/credit balance is too low/i`) exists only in the uncommitted working tree on branch `fix/comprehensive-error-classification`. It was never committed, never built into dist, never deployed.
- `maybeNotifyAdmin()` line 156 in source and line 46 in deployed dist: `if (errorClass !== 'usage_limit' && errorClass !== 'auth') return;` — `credit_balance` is absent from this allowlist in both source and deployed bundle.
- All 4 running framework bots (kristina, trainer, chief-of-staff, hali99) share the same `/opt/botforge/packages/core/dist/`.

### Unverified / Out of Scope for This Investigation

- The exact time the Anthropic credit balance reached zero (not visible in journals, would require Anthropic Console).
- Whether any user messages were silently dropped with no response at all (logs show brain errors but not whether Telegram delivery was confirmed for all 4 generic replies).
- Whether trainer/chief-of-staff/hali99 users attempted brain-calling interactions during the outage window (their journals were clean, but this investigation did not do a full journal scan of those services).
- The precise series of events leading to the working-tree edits on `fix/comprehensive-error-classification` being left uncommitted (no git history to trace; this branch appears to be a continuation of in-progress work).

---

## Relationship to Prior Incidents

This is a **recurrence** of the 2026-05-25 incident documented in `botforge-honest-brain-error-messages`:

> 2026-05-25: Kristina spammed "Sorry, I couldn't process that." all day because the monthly workspace spend cap was hit.

The 2026-05-25 fix (`29aba8f`) correctly solved that incident's specific error string (`"You have reached your specified API usage limits"`). But:

1. It did not handle the distinct `"Credit balance is too low"` string (a different Anthropic billing failure mode).
2. The follow-on work that would have covered this case was written but left as uncommitted working-tree changes.
3. The `botforge-framework-sha-deploy-truth` memory explicitly warns: "always diff against the server before any deploy from main" and documents the risk of building from the wrong source state. The inverse risk — building from the right state but not committing working-tree improvements — was not captured as a process guard.

The pattern: billing error hits → generic message → manual investigation → fix written → fix not fully shipped → next billing error variant repeats the cycle.

---

## Required Fixes (Investigation Only — No Code Changes Made)

The following defects were confirmed. Remediation is out of scope for this investigation.

1. **Commit + build + deploy `error-messages.ts` working-tree changes.** The `credit_balance` regex and all other additions on `fix/comprehensive-error-classification` must be committed, `packages/core` must be rebuilt, and the new dist must replace `/opt/botforge/packages/core/dist/` on acemagic (following the `botforge-framework-sha-deploy-truth` procedure: backup, rsync, staged restart, verify SHA).

2. **Add `credit_balance` and `payment_required` to `maybeNotifyAdmin` allowlist.** Line 156 of `packages/core/src/error-messages.ts` must expand the guard condition to include both new billing error classes. This is a source-level defect independent of the build/deploy issue.

3. **Replenish Anthropic credit balance.** The outage trigger is still active.
