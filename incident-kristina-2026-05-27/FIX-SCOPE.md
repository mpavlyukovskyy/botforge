# Fix Scope: Kristina credit-balance silent failure (2026-05-27)

## Confirmed incident state

### Layer 1 — Operational (not a code fix)
Anthropic credit balance was depleted. Already resolved by topping up.

### Layer 2 — Stale dist (confirmed)

The deployed `chunk-N5VWYLU5.js` (md5 `e02ed6544189034f887fbb61a6c323de`) was built from
the **original 5-class** version of `error-messages.ts` shipped in commit `29aba8f` (2026-05-25).

The current `packages/core/src/error-messages.ts` has 14 error classes including
`credit_balance` and `payment_required` — but these changes are **uncommitted local working-tree
edits** only. They have never been committed, built, or deployed.

Evidence:
- `git log -- packages/core/src/error-messages.ts` shows exactly one commit: `29aba8f`
- `git diff HEAD -- packages/core/src/error-messages.ts` shows +220 lines of new error classes
- `wc -c` on source: 8055 bytes vs dist chunk: 3073 bytes
- Both local and acemagic dist chunks have identical md5 `e02ed6544189034f887fbb61a6c323de`
- Acemagic chunk mtime: `2026-05-25 16:35:48` — exactly the `29aba8f` commit timestamp
- The local chunk mtime of `2026-05-27 07:50:35` is a filesystem timestamp update (copy/rsync),
  NOT a rebuild from the current source

FRAMEWORK_SHA on both local and acemagic: `29aba8fc41c01ed2edce004a9a48c0ea63a827bb`

This IS a stamping lie in the sense that: FRAMEWORK_SHA correctly records when dist was built
(commit `29aba8f`), but at the time of that build, `error-messages.ts` only had 5 classes.
The expanded source was edited locally AFTER the build+deploy and was never committed or rebuilt.

### Layer 3 — maybeNotifyAdmin gap (confirmed)

`maybeNotifyAdmin` in the deployed dist (`chunk-N5VWYLU5.js`, line 46) guards:
```js
if (errorClass !== "usage_limit" && errorClass !== "auth") return;
```

The current source (`packages/core/src/error-messages.ts`, line 156) has the same guard:
```ts
if (errorClass !== 'usage_limit' && errorClass !== 'auth') return;
```

So `credit_balance` and `payment_required` are silently dropped by `maybeNotifyAdmin` in
**both** the deployed dist AND the current (uncommitted) source. This is a bug that exists in
the current source and must be patched before building.

### Runtime call-site analysis

- `brain-processor.ts` (primary, line 321): calls both `renderError` and `maybeNotifyAdmin`
  with `inst.store` (the shared per-bot `Map<string,unknown>` created once at bot startup —
  the throttle key persists across messages correctly)
- `runtime.ts` outer backstop (line 449-461): calls only `classifyError` + `renderError`,
  does NOT call `maybeNotifyAdmin`. This is a secondary gap but acceptable for now —
  errors reaching the outer backstop are already double-logged.
- `ADMIN_USER_ID=381823289` IS set in `/opt/botforge/.env` — the alert path is live once
  the code gate is fixed.

---

## Task 1 — Minimal source patch

The only file that needs changing is `packages/core/src/error-messages.ts`, line 156.

```diff
--- a/packages/core/src/error-messages.ts
+++ b/packages/core/src/error-messages.ts
@@ -153,7 +153,7 @@ export async function maybeNotifyAdmin(args: {
   const { errorClass, errMsg, botName, adapter, store, log } = args;
-  if (errorClass !== 'usage_limit' && errorClass !== 'auth') return;
+  if (errorClass !== 'usage_limit' && errorClass !== 'auth' && errorClass !== 'credit_balance' && errorClass !== 'payment_required') return;
 
   const adminId = process.env.ADMIN_USER_ID;
```

That single line change makes `credit_balance` and `payment_required` admin-actionable,
matching the intention of the existing `renderError` copy for those classes.

The updated test assertion to add to `error-messages.test.ts` (also not yet committed):

```diff
+test('maybeNotifyAdmin fires for credit_balance and payment_required', async () => {
+  const sent: string[] = [];
+  const mockAdapter = {
+    send: async ({ text }: { chatId: string; text: string }) => {
+      sent.push(text);
+      return '1';
+    },
+  } as any;
+  const store = new Map<string, unknown>();
+  const log = { debug: () => {}, info: () => {} } as any;
+  const origEnv = process.env.ADMIN_USER_ID;
+  process.env.ADMIN_USER_ID = 'test-admin';
+  try {
+    await maybeNotifyAdmin({ errorClass: 'credit_balance', errMsg: 'Credit balance is too low', botName: 'kristina', adapter: mockAdapter, store, log });
+    assert.equal(sent.length, 1);
+    assert.match(sent[0], /credit_balance/);
+    await maybeNotifyAdmin({ errorClass: 'payment_required', errMsg: '402 payment required', botName: 'kristina', adapter: mockAdapter, store, log });
+    assert.equal(sent.length, 2);
+  } finally {
+    process.env.ADMIN_USER_ID = origEnv;
+  }
+});
```

---

## Task 2 — Build/deploy verification

### What a `pnpm build` from `packages/core` does

From `packages/core/package.json`:
```
"build": "tsup src/index.ts src/error-messages.ts ... --format esm --dts --clean && node -e \"...git rev-parse HEAD...writeFileSync('dist/FRAMEWORK_SHA',...)\""
```

Running `pnpm build` in `packages/core` will:
1. Compile all listed source files with tsup → regenerate `dist/chunk-N5VWYLU5.js` (and all others) from current source
2. Write the current `git rev-parse HEAD` to `dist/FRAMEWORK_SHA`

**Warning:** the source edits to `error-messages.ts` are currently uncommitted. Running the
build without committing first will stamp FRAMEWORK_SHA with `b44dab5a...` (current HEAD),
but the dist will include logic from a source file that HEAD does NOT contain. This makes
FRAMEWORK_SHA a lie again in the other direction.

**Correct sequence: commit first, then build.**

### Safe build and redeploy sequence

The memory note [[botforge-framework-sha-deploy-truth]] documents the exact pattern. Apply it:

```bash
# ── STEP 0: Commit the source changes ────────────────────────────────────────
cd /Users/Mark/Documents/dev/botforge
git add packages/core/src/error-messages.ts
# (also add test file if you update it)
git commit -m "fix(core): alert admin on credit_balance and payment_required errors"

# ── STEP 1: Back up the deployed dist on acemagic ────────────────────────────
TS=$(date +%Y%m%d-%H%M%S)
ssh acemagic "cp -a /opt/botforge/packages/core/dist /opt/botforge/packages/core/dist.bak-${TS}"

# ── STEP 2: Build locally (clean) ────────────────────────────────────────────
cd /Users/Mark/Documents/dev/botforge
pnpm --filter @botforge/core build
# Verify new chunk exists and is larger than the old one (old was 3073 bytes)
wc -c packages/core/dist/chunk-N5VWYLU5.js

# ── STEP 3: Verify FRAMEWORK_SHA in local dist matches the commit just made ──
cat packages/core/dist/FRAMEWORK_SHA
# Should print the SHA of the commit from STEP 0

# ── STEP 4: rsync only core/dist to acemagic ─────────────────────────────────
rsync -az --delete packages/core/dist/ acemagic:/opt/botforge/packages/core/dist/

# ── STEP 5: Staged restart ───────────────────────────────────────────────────
ssh acemagic "sudo systemctl restart botforge-kristina"
ssh acemagic "sudo systemctl restart botforge-trainer"
ssh acemagic "sudo systemctl restart botforge-chief-of-staff"
# (or whatever the actual service names are — confirm with: ssh acemagic "systemctl list-units | grep botforge")

# ── STEP 6: Prove the fix is live ────────────────────────────────────────────
# Confirm FRAMEWORK_SHA updated
ssh acemagic "cat /opt/botforge/packages/core/dist/FRAMEWORK_SHA"

# Confirm chunk md5 changed from e02ed6544189034f887fbb61a6c323de
ssh acemagic "md5sum /opt/botforge/packages/core/dist/chunk-N5VWYLU5.js"

# Smoke test: trigger a credit_balance error on a dev instance (or grep logs for
# the next real error to see the new error class appear)
```

---

## Task 3 — FRAMEWORK_SHA stamping lie confirmed

**Finding:** The FRAMEWORK_SHA on both local and acemagic says `29aba8f`. This is NOT a lie
about the dist content — the dist WAS genuinely built at commit `29aba8f`. The lie is that
the source `error-messages.ts` was subsequently edited (locally, uncommitted) to add 9 more
error classes, and those edits were never committed, never built, and never deployed. The
FRAMEWORK_SHA continues to accurately describe the dist that is running, but the running dist
is now stale relative to the local source.

This is a **source/dist drift** problem, not a SHA-stamping problem. The SHA stamp is honest.
The stale source edits are the anomaly.

---

## Task 4 — Call-site and store analysis

- `brain-processor.ts` is the primary error catch site (lines 315-329)
- It calls `maybeNotifyAdmin` with `inst.store` which is the bot-lifetime `Map` (runtime.ts:167)
- The throttle key `_adminNotified:credit_balance` will persist across messages — one alert per
  30 minutes per bot instance, correct behavior
- `ADMIN_USER_ID=381823289` is set in `/opt/botforge/.env` — no blocker there
- The `runtime.ts` outer backstop (lines 449-461) does NOT call `maybeNotifyAdmin`. This means
  if an error escapes `brain-processor.ts` and falls through to the outer catch, the admin will
  not be alerted from that path. This is a secondary gap but low-priority — errors in that path
  are rare and are logged.
- After the code fix, the alert will fire because: `classifyError("Credit balance is too low")`
  already returns `'credit_balance'` in the CURRENT source (just not in the DEPLOYED dist), and
  after rebuilding from the patched source, `maybeNotifyAdmin` will no longer early-return for
  `credit_balance`.

---

## Task 5 — Proactive health signal feasibility

A reactive-only approach (classify on user message) means silence until someone messages the
bot. A proactive cron ping is feasible and low-cost:

**Option A — Cheap Anthropic ping cron (recommended)**

Add a cron job (e.g. every 4 hours) to the existing botforge cron infrastructure that does:
```js
// In bots/kristina/cron/ or a shared health-check cron
const { Anthropic } = require('@anthropic-ai/sdk');
const client = new Anthropic();
try {
  await client.messages.create({
    model: 'claude-haiku-3', // cheapest
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });
} catch (err) {
  const errorClass = classifyError(err);
  if (errorClass === 'credit_balance' || errorClass === 'payment_required') {
    await adapter.send({ chatId: ADMIN_USER_ID, text: `🚨 Health check: Anthropic credit balance too low. Top up required.` });
  }
}
```

This adds ~$0.000003 per ping (1 input token on Haiku) and detects the outage proactively.

**Option B — Anthropic balance API (if available)**

Anthropic does not expose a public REST endpoint to query credit balance as of the knowledge
cutoff. Not feasible without scraping the Console.

**Option C — Monitor the error on the first user message (current approach, reactive)**

Lowest friction, no ongoing cost. With the code fix, the first failed message triggers an
admin alert within seconds. Acceptable for a non-24/7 use case.

**Recommendation:** Start with the code fix (Option C improved). Add Option A only if silent
outages recur — the proactive cron adds operational complexity for marginal gain.

---

## Summary of findings vs hypotheses

| Hypothesis | Confirmed? | Notes |
|---|---|---|
| `credit_balance` regex in source but not in dist | CONFIRMED | Source has it, dist built from original 5-class version |
| Dist md5 == `e02ed6544189034f887fbb61a6c323de` locally and on acemagic | CONFIRMED | Identical |
| `maybeNotifyAdmin` only fires for `usage_limit`/`auth` | CONFIRMED in both source AND dist | The source still has the bug even after the extended classifyError was added |
| FRAMEWORK_SHA says `29aba8f` but dist predates credit-regex | PARTIALLY: SHA is honest (dist was built at 29aba8f), but source was edited AFTER without committing/rebuilding | Not a stamping lie, a source-drift issue |
| ADMIN_USER_ID is set | CONFIRMED | `ADMIN_USER_ID=381823289` in `/opt/botforge/.env` |
| `inst.store` persists across messages for throttle | CONFIRMED | Single `Map` created at bot init in runtime.ts:167 |
| Runtime outer catch lacks `maybeNotifyAdmin` | CONFIRMED | Line 449-461 does renderError only — secondary gap |
