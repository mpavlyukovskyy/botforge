# FINAL PLAN (v3, vetted): Whoop token hardening — never spam again, never self-kill the token again

Two red-team rounds applied: round 1 = 35 issues (2 blockers), round 2 = 30 issues (3 blockers).
Changelogs at bottom. Execution sequence: EXECUTION-whoop-token-hardening.md.

Goal state:
- G1. The client can never kill its own token chain (no reuse, no stale overwrite, no concurrent
  refresh — including cross-process). One documented residual: crash after the HTTP request is sent
  but before persist (window ~seconds) — unavoidable with rotation; the dead-state machinery turns
  it into one alert + escape-hatch retries, not spam.
- G2. A dead token produces exactly ONE actionable alert + bounded reminders, never a spam loop.
- G3. Transient outages produce zero noise unless prolonged (>2h) and can never falsely kill the token.
- G4. Recovery is one command; the recovery path itself cannot re-kill the token.
- G5. Something OUTSIDE the bot fires if Whoop data goes stale (fleet-watchdog, one owner per concern).
- G6. Logs and user-facing replies never lie.

## Clock rule (applies to every workstream)
All new temporal state is JS epoch **seconds** (`Math.floor(Date.now()/1000)`) in INTEGER columns or
inside bot_state JSON values. Never `datetime('now')` for comparisons (fake-timer-testable by
construction; SQL clock is unfaked). `updated_at` is set explicitly in every UPDATE that should bump it.

## Workstream A — Token manager (`lib/whoop-client.js`, `lib/db.js`)

A0. **Schema** (migrated in `ensureDb()` first-touch — NOT only the lifecycle start hook):
`status TEXT DEFAULT 'active'`, `dead_reason TEXT`, `dead_at INTEGER`,
`consecutive_invalid_request INTEGER DEFAULT 0`, `first_transient_failure_at INTEGER`,
`lock_token TEXT`, `last_dead_probe_at INTEGER`.
Migration rules: `busy_timeout=5000` pragma first; `CREATE TABLE IF NOT EXISTS oauth_tokens`
(full new shape) BEFORE the ALTERs; catch ONLY /duplicate column name/, rethrow everything else.

A1. **Critical section.**
- Ownership lock: random `lock_token` + `locked_at` (epoch s); release/steal via
  `UPDATE … WHERE lock_token = <mine>` / stale-steal at 120s. Never clear another holder's lock.
- Inside the lock, re-read the row; if `refresh_token` changed since pre-lock read → another caller
  refreshed → return the new token. Always present the re-read `refresh_token`.
- Fetch with AbortController armed through the **entire body read** (30s).
- On 2xx-with-tokens: **always** attempt the A2 CAS persist — no wall-clock discard (a completed
  refresh means Whoop already rotated; discarding the result would orphan the new token and the next
  caller's replay of the old one = reuse = self-kill). The CAS is the only staleness gate.
- Lock-loser: poll 500ms up to 15s; re-read; valid → return; else throw `RefreshUnavailableError`.
  Never return a known-expired token.

A2. **Persist-before-return with CAS.** On 2xx with parsed JSON, non-empty access+refresh tokens:
ONE UPDATE `SET access_token, refresh_token, expires_at, status='active', dead_reason=NULL,
dead_at=NULL, consecutive_invalid_request=0, first_transient_failure_at=NULL,
last_dead_probe_at=NULL, updated_at=<now> WHERE provider='whoop' AND refresh_token=<presented>`.
0 rows → rotated under us → discard, re-read, return newer. `INSERT OR REPLACE` is banned for
oauth_tokens everywhere; writes are `INSERT … ON CONFLICT(provider) DO UPDATE`.

A3. **Error taxonomy — total function, safe default.**
- Toward death ONLY (and each death-marking is CAS'd on the presented refresh_token; 0 rows →
  treat as transient): parsed-JSON `error='invalid_grant'` → dead immediately; parsed-JSON
  `error='invalid_request'` → dead after 3 consecutive (counter on the row, cross-process,
  restart-proof; fosite concurrent-conflict descriptions are transient and never count).
- CONFIG_ERROR (alert-state only — row stays 'active', attempts continue, alertOnce dedups):
  401/invalid_client/unauthorized_client, or missing/empty WHOOP_CLIENT_ID/SECRET (checked
  up-front, never send "undefined"). Alert: "check WHOOP_CLIENT_ID/SECRET on acemagic", NOT re-auth.
- NEVER_AUTHORIZED (4th terminal class): no oauth row, or refresh_token IS NULL → ReauthRequiredError,
  own alert key, `no-token-skip` log; no lock attempts, no HTTP, no counters.
- Everything else — network, timeout, 429, 5xx, 403, HTML/unparseable bodies, unknown codes,
  SQLITE_BUSY/DB errors — transient. Transient neither increments nor resets the permanent counter;
  only a CAS-matched success resets it (sets `first_transient_failure_at=NULL` too).
- Dead status is row-truth, re-read on every `getAccessToken` call (no process cache) — SSH re-auth
  revives the running bot; separate processes observe it.
- Dead blocks the token endpoint. Access-token serving while dead: `dead_reason='invalid_grant'`
  (chain revoked) → throw immediately; `invalid_request`-class death → serve until local expiry,
  and any data-API 401 received while dead is treated as ReauthRequiredError by callers (B3).
- **Escape hatch**: while dead, one verification refresh per 12h via CAS claim BEFORE any HTTP:
  `UPDATE … SET last_dead_probe_at=<now> WHERE provider='whoop' AND status='dead' AND
  refresh_token=<seen> AND (last_dead_probe_at IS NULL OR last_dead_probe_at < <now>-43200)`;
  only the 1-row winner probes (through the full A1 path). On death, `last_dead_probe_at=dead_at`
  (first probe at dead_at+12h; zero token-endpoint calls in the first 12h). Success → A2 CAS
  auto-revives. Caps false-positive-death damage; cross-process and crash-loop safe.

A4. Refresh body **unchanged** (proven full multi-scope list). Log the response `scope` field after
the first post-re-auth refresh (observability only).

A5. Unwrap double-wrapped error text. New error classes: `ReauthRequiredError`,
`RefreshUnavailableError`, `WhoopConfigError`.

A6. recovery-fetch: one AbortController threaded through `fetchPaginated`/`fetchAndStoreTodayRecovery`,
aborted on deadline; budget 12s → 45s (> 30s fetch + 15s lock-wait). No orphaned chains.

## Workstream B — Alert state machine (`lib/alert-state.js` + cron wiring)

B1. Keys in bot_state (values = JSON with epoch-seconds timestamps): `whoop_token_dead`,
`whoop_config_error`, `whoop_transient_outage`, `whoop_never_authorized`.
- Death alert: what happened + literal re-auth command + degradation note ("workouts continue
  without recovery data until re-auth"). Reminders +6h, +24h, then daily. Death sets/suppresses:
  the `whoop_transient_outage` key is cleared on death (no double-nag, no stale recovery notice).
- Transient: silent unless `first_transient_failure_at` shows >2h continuous → ONE alert including
  the last raw provider error; daily reminder max; recovery notice when cleared.
- **Emission and recovery are observation-based** (idempotent, works no matter which process changed
  the row): every Whoop-section cron tick: (i) `status='dead'` + dead key absent → send death alert,
  set key; (ii) `status='active'` + any whoop_* key set → send the matching recovery message, clear
  ALL whoop_* keys. Covers deaths marked by backfill scripts, SSH re-auth revival, escape-hatch
  success from another process, and manual DB surgery — uniformly, within ≤5 min.

B2. `cron/token-refresh.js`: **three independent sections** — Whoop token (dead-skip applies here
only), Hevy event polling (logs a per-tick outcome line, e.g. `hevy-poll ok (0 events)`), Telegram
offset persistence (finally-position, un-skippable). Truthful states: `refreshed` / `valid-skip` /
`dead-skip (reauth pending)` / `no-token-skip` / `transient-fail (n, reason)` / `config-error`.

B3. User-facing truth: `/sync` per-source outcomes ("Whoop: token dead since <dead_at>, re-auth:
<command> | 8Sleep: ok"), never "Sync complete" on a failed source. `/status`, `/progress`: one-line
dead banner. Caller audit (daily-sync, recovery-fetch, bedtime-helper, morning-workout, commands,
scripts): ReauthRequiredError AND data-API 401-while-dead → info "reauth-pending skip", zero
unsolicited sends. (morning_workout's degraded recovery-unknown card is a legitimate send.)

## Workstream C — Cron schedule (load-spreading; safety is A1's lock)

C1. token_refresh → `"2,7,12,17,22,27,32,37,42,47,52,57 * * * *"` (UTC). node-cron 3.0.3 mangles
range-step `2-57/5` (verified) — explicit list only; expansion pinned by test (F6) which also
asserts the mangling still exists (detects a future node-cron fix invalidating the rationale).
C2. Deploy does NOT ship `bots/trainer.yaml` (service reads `/opt/botforge/bots/trainer.yaml`):
rollout backs up the server copy, scp's the new one, restarts, and verifies the journal logs the
new expression at boot.

## Workstream D — One-command re-auth (`scripts/whoop-reauth.mjs`, Mac)

D1. Browser consent (existing mkcert/localhost:8090; auto-create certs). Creds:
`~/.claude/secrets/api-keys.env`, else pull from acemagic `/opt/botforge/.env` over SSH.
D2. Install over SSH by absolute path `/opt/botforge/data/Trainer-trainer.db`: one transaction via
`sqlite3 -cmd ".timeout 5000"`, tokens via stdin (no shell interpolation),
`INSERT … ON CONFLICT(provider) DO UPDATE` setting token fields, `status='active'`, all counters
NULL/0, `last_dead_probe_at=NULL`, `updated_at=<now>` — **lock columns untouched** (never clobber a
holder; an in-flight dead-chain refresh CAS simply 0-rows against the new token). Assert exactly
1 row changed; retry 3× 2s on busy. Never writes the local decoy `bots/trainer/data/` DB.
D3. Verify WITHOUT rotation: `/user/profile/basic` with the fresh ACCESS token (no script-side
refresh, ever). Bot revival is observation-based (B1): recovery message within ≤5 min, truthful
`refreshed` within ~55 min. `--watch` polls journalctl; PASS/FAIL printed + which DB was touched.
D4. Death alert embeds: `cd ~/Documents/dev/botforge/bots/trainer && node scripts/whoop-reauth.mjs`.
D5. `--dry-run` (exact semantics): skips browser, fixed fake token pair; `--db <path>` accepted ONLY
with `--dry-run` (prod path otherwise un-overridable); ssh/scp resolved via PATH so tests install a
shim that executes the received sqlite3 command against a temp DB. Exercised by vitest (F11).

## Workstream E — Standing liveness check (fleet-watchdog)

E1. `check_whoop_freshness()` added to `infra/fleet-watchdog.sh` (deployed to
`/opt/health-probes/`). Parameterized for kill-testing the exact shipped artifact:
`WHOOP_DB=${WHOOP_DB_OVERRIDE:-/opt/botforge/data/Trainer-trainer.db}`,
`WHOOP_STALE_HOURS=${WHOOP_STALE_HOURS_OVERRIDE:-72}`. Opens `sqlite3 -readonly`. `dead_at` and all
timestamps are epoch seconds (pinned by tests). Conditions:
- (a) bot-wedged: `status='dead' AND now-dead_at > 3600` AND dead key absent from bot_state.
- (b) staleness: `max(date) WHERE whoop_recovery_score IS NOT NULL` older than 72h, suppressed when
  any whoop_* alert key is set (bot already alerting / config known-broken).
E2. Ownership in header: fleet-watchdog = service-up + Whoop freshness; Kuma = heartbeat; no
separate trainer deep probe (kristina one-owner precedent). Existing hourly dedup reused; kill-test
cleanup must rm the dedup state file to avoid a spurious "recovered" DM.
E3. Kill-test BOTH branches against a `.backup`-created copy via the override env vars, on the
deployed script.

## Workstream F — Test suite (vitest; root config; run as `npx vitest run bots/trainer`)

Baseline: 12 existing files / 120 tests green (recorded in PR as regression reference).
1. Critical section: re-read inside lock; loser never returns expired token; ownership (stale holder
   can't release stealer's lock); slow-body (headers 1s, trickling body) → abort fires, no second
   refresh HTTP; success at lockAcquiredAt+100s with no steal → persisted (no discard).
2. CAS: stale success can't overwrite newer token; success resets ALL state incl.
   first_transient_failure_at + sets updated_at; mismatched success touches nothing.
3. Taxonomy table: 503/429/timeout/network/403-HTML/400-HTML/truncated-JSON/SQLITE_BUSY → transient;
   401 invalid_client + missing env → CONFIG_ERROR; invalid_grant → dead (CAS-guarded);
   3× invalid_request → dead; transient interleaving neither increments nor resets the counter
   (so 2× + 503 + 1× = 3 → dead; only a CAS-matched success resets it — a live token's successes
   keep it at 0, and the 12h escape hatch caps false-positive death); conflict-invalid_request → transient.
4. Dead machine: zero token-endpoint HTTP in first 12h (probe anchored dead_at+12h, fake timers,
   epoch-seconds rule); probe CAS-claims across two connections (only one probes); invalid_grant
   death → access token not served; invalid_request death → served till expiry; SSH-style row update
   revives next tick; restart (fresh process state) does NOT re-probe early.
5. Alert state: ONE death alert; reminder cadence (fake timers); recovery message; transient 2h
   alert w/ raw error; config alert; death clears transient key; per-key independence;
   observation-based emission (death marked via second connection → next tick alerts exactly once).
6. Cron: Hevy + offset run when dead; per-tick hevy outcome line; truthful states; expression
   expansion pinned via deep-require of node-cron's convert-expression (node-cron added to root
   devDependencies at the lockfile-exact version) — asserts the explicit list expands to 12 minutes
   AND that `2-57/5` is still mangled AND trainer.yaml contains no range-step.
7. **Cross-process (the G1 proof)**: `WHOOP_TOKEN_URL` env override added to whoop-client; two
   spawned child processes race getAccessToken against a shared temp DB + a local http token-stub →
   stub receives exactly ONE request. (The two-connection in-process test is kept but scoped/named
   as CAS-semantics, not the cross-process proof.)
8. Migrations: pre-existing old-shape table → ALTERs apply, existing row reads status='active',
   counter=0; fresh empty DB → single ensureDb yields full new shape; non-duplicate-column errors
   rethrow (fail-loud).
9. **Incident replay** (the regression test for THIS incident): real cron handler, mocked fetch
   sequence [200, 503×6, 400-invalid_request×N] → exactly ONE adapter.send total
   (key=whoop_token_dead), counter 0→0→3, status active→active→dead, no transient alert (<2h),
   no spurious transient-recovery after death.
10. Probe SQL: node script vitest runs against fixture DBs (both conditions, suppression,
    epoch-seconds dead_at, default-vs-override path selection).
11. whoop-reauth --dry-run: PATH-shim ssh; asserts .timeout 5000, stdin token passing, temp-DB row
    correct, 1-row assert fires, stdout names target DB, --db rejected without --dry-run.
12. NEW command tests: /sync with Whoop dead + 8Sleep ok → per-source line, no "Sync complete";
    /status & /progress banner. Caller-audit: zero unsolicited sends on dead paths
    (morning-workout degraded card explicitly excluded as legitimate).
13. Grep-style guards: no INSERT OR REPLACE on oauth_tokens; no datetime('now') comparisons in
    dead/transient/probe/reminder logic.

**CI**: ci.yml currently runs ZERO tests. This PR adds a `npx vitest run bots/trainer` step to
ci.yml (runs in ~seconds) so the gate enforces itself on this and future PRs.

## Workstream G — Rollout
See EXECUTION-whoop-token-hardening.md (final). Key order change from v2: the fleet-watchdog deploy
+ kill-tests run BEFORE the Mark-dependent re-auth step, so the shipping-rule cover exists during
any multi-day dead window. No secrets ever land in the repo (snapshots redacted to lengths/metadata).

## Non-goals / follow-ups (unchanged from v2)
Eight Sleep silent-failure architecture (follow-up: extend watchdog staleness + /sync surfacing);
alert-state → @botforge/skill candidate after trainer proves it; audit chief-of-staff
calendar-client token persistence; stale-artifact cleanup (decoy data/ dir is removed by the deploy
swap; pems + data/ excluded from build; dist/ regenerated by fixed clean build).

## v2 → v3 changelog (red-team round 2)
- BLOCKER: oauth-row snapshots in docs/ would commit live tokens → redact to metadata/lengths; raw
  stays in /tmp. Grep gate before commit.
- BLOCKER: watchdog kill-test unexecutable → env-var overrides on the deployed artifact, `.backup`
  copy, dedup-state cleanup, epoch-seconds pinning.
- BLOCKER: CI runs zero tests → vitest step added to ci.yml in this PR; gates reference the real
  baseline (12 files/120 tests) and the exact command.
- Removed A1 wall-clock discard (it would self-kill the chain by orphaning successful rotations);
  CAS is the only staleness gate; documented the crash-after-send residual.
- Escape hatch: persisted `last_dead_probe_at`, CAS-claimed, anchored dead_at+12h.
- Success CAS resets first_transient_failure_at + sets updated_at (Phase 11 gate now testable).
- Observation-based alert emission/recovery on cron ticks (script-marked deaths alert; SSH re-auth
  recovery message within ≤5 min; CONFIG_ERROR exit defined; all keys cleared on success).
- NEVER_AUTHORIZED class for missing row/NULL refresh token (no lock-loser timeouts, one alert).
- invalid_grant death stops serving the (revoked) access token; 401-while-dead → ReauthRequired.
- Migration: busy_timeout, CREATE-before-ALTER, duplicate-column-only catch.
- D2 leaves lock columns alone; epoch-seconds clock rule everywhere; cron-pin test mechanism
  specified (root devDep + deep-require); cross-process test made real (child processes +
  WHOOP_TOKEN_URL + http stub); incident-replay test added; command tests added (they didn't exist);
  fleet-watchdog deployed via /tmp + sudo cp (root-owned target); trainer.yaml backed up pre-scp;
  forensics reads use `sqlite3 -readonly` without sudo; watchdog phase moved before re-auth.
