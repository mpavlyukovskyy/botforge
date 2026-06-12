# FINAL execution sequence (vetted, v2): Whoop token hardening

Implements PLAN v3. Each step has a verification gate. Phase order: watchdog ships BEFORE the
Mark-dependent re-auth so shipping-rule cover exists during any dead window.

## Phase 0 — Preconditions
0.1 `cd /Users/Mark/Documents/dev/botforge && git checkout main && git pull`.
0.2 Forensics snapshot (REDACTED for anything that may be committed; raw stays in /tmp only):
    `ssh acemagic 'sqlite3 -readonly /opt/botforge/data/Trainer-trainer.db "SELECT provider,status,length(access_token),length(refresh_token),expires_at,updated_at FROM oauth_tokens"'`
    (no sudo, -readonly — a root rw open could create root-owned WAL sidecars and lock the bot out).
0.3 `git checkout -b fix/trainer-whoop-token-hardening`.
0.4 Record test baseline: `npx vitest run bots/trainer` → expect 12 files / 120 tests green.
GATE: clean branch off fresh main; baseline recorded.

## Phase 1 — Schema + DB layer (lib/db.js)
1.1 ensureDb() first-touch migration: `busy_timeout=5000` pragma; CREATE TABLE IF NOT EXISTS
    oauth_tokens (FULL new shape) before ALTERs; ALTER-adds for status/dead_reason/dead_at/
    consecutive_invalid_request/first_transient_failure_at/lock_token/last_dead_probe_at;
    catch ONLY /duplicate column name/, rethrow everything else.
1.2 upsertOAuthToken → INSERT … ON CONFLICT(provider) DO UPDATE (sets updated_at; grep-guard: no
    INSERT OR REPLACE on oauth_tokens anywhere).
1.3 Helpers: getTokenRow (fresh read), ownership lock (lock_token, steal 120s, release WHERE mine),
    casUpdateTokenOnSuccess (full reset list incl. first_transient_failure_at, last_dead_probe_at,
    updated_at), casMarkTokenDead (sets last_dead_probe_at=dead_at; clears nothing else),
    casIncrementInvalidRequest, casClaimDeadProbe (12h window). All timestamps epoch seconds.
GATE: tests/whoop-db.test.js green (migrations incl. fresh-DB + old-shape + fail-loud case, CAS
semantics, lock ownership, grep guards).

## Phase 2 — Token manager (lib/whoop-client.js)
2.1 Rewrite per PLAN A1–A6 (re-read inside lock; abort through body; NO wall-clock discard — always
    CAS-persist 2xx; loser poll → RefreshUnavailableError; total taxonomy w/ transient default;
    CONFIG_ERROR up-front env check; NEVER_AUTHORIZED class; dead = row-truth per call;
    invalid_grant death stops serving access token; 12h escape hatch via casClaimDeadProbe;
    scope body unchanged; WHOOP_TOKEN_URL env override (test hook); unwrapped errors).
2.2 recovery-fetch: threaded AbortController, 45s budget.
GATE: tests/whoop-client.test.js (taxonomy table, critical section, slow-body, late-success-persist,
dead machine, escape hatch, fake timers per the epoch-seconds clock rule) +
tests/whoop-cas-semantics.test.js (two in-process connections) +
tests/whoop-cross-process.test.js (two CHILD PROCESSES + local http token stub → exactly one
token-endpoint request). All green.

## Phase 3 — Alert state machine (lib/alert-state.js)
3.1 Keys whoop_token_dead / whoop_config_error / whoop_transient_outage / whoop_never_authorized;
    alertOnce + reminders (+6h/+24h/daily); death clears transient key; observation-based emission
    AND recovery (PLAN B1) — tick sweep sends death alert if dead+key-absent, recovery if
    active+any-key-set, clearing all whoop_* keys.
GATE: tests/alert-state.test.js (dedup, cadence, recovery, key interplay, observation-based both
directions incl. second-connection death). Green.

## Phase 4 — Cron + callers (B2/B3)
4.1 token-refresh cron: three independent sections; offset persistence finally-position; per-tick
    hevy outcome line; truthful states; alert-state sweep wired.
4.2 Caller audit: ReauthRequiredError AND 401-while-dead → "reauth-pending skip", zero sends
    (recovery-fetch, daily-sync, bedtime-helper, morning-workout, commands, scripts).
4.3 /sync per-source outcomes; /status + /progress dead banner.
GATE: tests/token-refresh-cron.test.js (Hevy+offset run when dead; states; sweep) +
tests/whoop-incident-replay.test.js ([200, 503×6, 400×N] → ONE send total, key=whoop_token_dead,
counter 0→0→3, status active→dead, no transient alert/recovery noise) +
NEW tests/commands-whoop-dead.test.js (/sync, /status, /progress) +
tests/whoop-caller-audit.test.js (zero unsolicited sends; morning-workout degraded card excluded).
Full `npx vitest run bots/trainer`: all pre-existing 120 + new green.

## Phase 5 — Cron schedule
5.1 trainer.yaml: token_refresh → `"2,7,12,17,22,27,32,37,42,47,52,57 * * * *"` (UTC).
5.2 node-cron added to ROOT devDependencies (lockfile-exact 3.0.3);
    tests/cron-expression.test.js deep-requires node-cron/src/convert-expression: asserts the list
    expands to exactly the 12 minutes, asserts `2-57/5` is still mangled, asserts trainer.yaml
    contains no range-step syntax.
GATE: test green.

## Phase 6 — Re-auth tool (scripts/whoop-reauth.mjs)
6.1 Per PLAN D1–D5: browser flow (auto-mkcert); creds local-secrets-else-SSH; absolute-path live-DB
    UPSERT via `sqlite3 -cmd ".timeout 5000"` with stdin token passing, lock columns untouched,
    assert 1 row, 3× retry; verify via /user/profile/basic with the fresh ACCESS token only (never a
    script-side refresh); `--watch` polls journal for recovery; `--dry-run` skips browser w/ fake
    tokens, `--db` only valid with `--dry-run`, ssh/scp via PATH (shim-testable).
6.2 Legacy whoop-auth.js local-DB write removed from the flow (never writes bots/trainer/data/).
GATE: tests/whoop-reauth-dryrun.test.js (PATH-shim ssh; .timeout + stdin + row assert + target-DB
print + flag validation). Green.

## Phase 7 — Fleet-watchdog freshness check (infra/fleet-watchdog.sh)
7.1 check_whoop_freshness(): WHOOP_DB_OVERRIDE / WHOOP_STALE_HOURS_OVERRIDE env params (defaults:
    live absolute path / 72), `sqlite3 -readonly`, conditions (a) dead>1h+key-absent and
    (b) staleness suppressed when any whoop_* key set; epoch-seconds arithmetic; existing hourly
    dedup; ownership split documented in header.
7.2 Freshness SQL in a vitest-testable node script: tests/probe-sql.test.js fixtures for both
    conditions + suppression + override selection.
GATE: probe tests green; `shellcheck infra/fleet-watchdog.sh` clean.

## Phase 8 — CI + PR + merge
8.1 ci.yml: add `npx vitest run bots/trainer` step (CI currently runs ZERO tests — this PR makes
    its own gate real; step must be in this PR to gate its own merge).
8.2 Docs: RUNBOOK-whoop-token.md (dead-state meaning, `sqlite3 -readonly` inspection commands,
    re-auth, rollback). Secret-scan gate before commit: no token-like strings in docs/
    (`grep -RInE '[A-Za-z0-9_-]{40,}' bots/trainer/docs/` → only known-benign matches).
8.3 Commit per phase; push; PR (RCA + plan links, test evidence incl. baseline 120, rollback plan);
    CI green INCLUDING the new vitest step; merge.
GATE: PR merged; main CI green with tests actually executed.

## Phase 9 — Deploy code to prod
9.1 Rollback prep: record pre-merge SHA; `ssh acemagic "cp /opt/botforge/bots/trainer.yaml /opt/botforge/bots/trainer.yaml.pre-hardening"`.
9.2 `pnpm botforge deploy trainer`. KNOWN: first CLI deploy's atomic swap deletes server-side
    scripts/, stale data/ leftovers, pems (live DB at /opt/botforge/data/ is outside the swap;
    loss is acceptable). If the 5s single-shot health check spuriously rolls back: re-run once;
    twice → STOP and inspect journal boot errors (fail-loud).
9.3 `scp bots/trainer.yaml acemagic:/opt/botforge/bots/trainer.yaml`
    `ssh acemagic "sudo systemctl restart botforge-trainer"`
GATE: journal shows clean boot + `token_refresh` scheduled with the NEW minute-list expression;
`ssh acemagic "curl -s localhost:8092/api/health"` → 200.
NOTE: between 9.2 and 9.3 the new code runs under the old */5 schedule — harmless; counter
increments and even the single death alert may already land in this window (it counts).

## Phase 10 — Prod E2E proof, part 1 (dead-token behavior; no Mark needed)
10.1 Within ~10–20 min of the 9.2 restart: ticks classify the dead token → counter reaches 3 →
     status='dead' → exactly ONE death alert (with re-auth command) in the trainer chat. An alert
     landing during the 9.2–9.3 window counts — scroll journal back to the 9.2 restart when counting.
10.2 Next 60+ min: `dead-skip (reauth pending)` ticks; ZERO further alerts; zero token-endpoint
     calls (escape hatch anchored at dead_at+12h); per-tick `hevy-poll` lines present;
     `SELECT updated_at FROM bot_state WHERE key='last_events_since'` advances each tick.
10.3 Row check (readonly): status='dead', dead_reason, consecutive_invalid_request≥3,
     last_dead_probe_at=dead_at.
10.4 Next morning_workout still delivers a recovery-unknown workout card (skip if Mark re-auths first).
GATE: exactly ONE alert since the 9.2 restart; spam stopped; Hevy/offset unaffected.

## Phase 11 — Liveness check live + kill-tests (BEFORE re-auth; shipping-rule cover for the dead window)
11.1 Deploy: `scp infra/fleet-watchdog.sh acemagic:/tmp/ && ssh acemagic "sudo cp /tmp/fleet-watchdog.sh /opt/health-probes/ && sudo chmod +x /opt/health-probes/fleet-watchdog.sh"`.
     Gate: `ssh acemagic "grep -q check_whoop_freshness /opt/health-probes/fleet-watchdog.sh"`.
11.2 Copy: `ssh acemagic 'sqlite3 -readonly /opt/botforge/data/Trainer-trainer.db ".backup /tmp/wd-test.db"'`.
11.3 Kill-test (a): on the COPY set status='dead', dead_at=now-7200, delete the dead key from
     bot_state; run `WHOOP_DB_OVERRIDE=/tmp/wd-test.db /opt/health-probes/fleet-watchdog.sh`
     → expect Telegram alert.
11.4 Kill-test (b): `WHOOP_DB_OVERRIDE=/tmp/wd-test.db WHOOP_STALE_HOURS_OVERRIDE=0 …` with keys
     cleared → expect staleness alert; with dead key present → expect suppression.
11.5 Cleanup: rm /tmp/wd-test.db; rm the whoop dedup state file under /opt/health-probes/state/
     (prevents a spurious "recovered" DM); watch one normal 5-min cycle stay silent (current state:
     dead + key set → both conditions correctly quiet).
GATE: both branches proven to fire AND healthy/expected-quiet states proven silent.

## Phase 12 — Recovery (requires Mark, ~3 min)
12.1 `cd ~/Documents/dev/botforge/bots/trainer && node scripts/whoop-reauth.mjs`
     → browser consent → installs on acemagic → profile-call verify → PASS.
12.2 Within ≤5 min: bot's observation sweep sends the recovery message (no restart needed).
     Within ~55 min: first truthful `refreshed` journal line; row updated_at advances (the CAS sets
     it explicitly); status='active'.
12.3 Next recovery cron or /sync → recovery_daily row with whoop_recovery_score NOT NULL.
GATE: recovery message + truthful refresh + fresh data row = full state-machine E2E proof in prod
(dead → one alert → re-auth → recovered).

## Phase 13 — Close-out
13.1 Post-recovery REDACTED row snapshot (same query as 0.2) into docs/ next to the RCA;
     secret-scan gate (8.2) re-run before commit.
13.2 Memory: topic file + MEMORY.md one-liner (incident, fix, runbook pointer; gotchas:
     trainer.yaml-not-shipped-by-deploy, node-cron range-step mangling, live-DB absolute path,
     CI-had-zero-tests).
13.3 Follow-ups confirmed filed (Eight Sleep probe, alert-state→skill, CoS calendar-client audit).
GATE: docs + memory committed clean of secrets; task list closed.

## Rollback (any phase ≥9)
`git revert <merge>` → `pnpm botforge deploy trainer` →
`ssh acemagic "cp /opt/botforge/bots/trainer.yaml.pre-hardening /opt/botforge/bots/trainer.yaml && sudo systemctl restart botforge-trainer"`.
Spam resumes (pre-fix behavior, known). Fleet-watchdog whoop check stays deployed and is safe:
condition (a) needs status='dead' which old code never sets (inert); condition (b) staleness DMs
remain the intended outside signal. Raw oauth snapshots preserved in /tmp.

## Failure-mode notes
- Mark unavailable for Phase 12: system sits in dead-skip with daily reminders; watchdog (Phase 11,
  already live) covers the wedged case. No action needed, no spam.
- Whoop consent fails at the portal: check developer.whoop.com app settings (redirect URI
  https://localhost:8090/callback must remain whitelisted); nothing redeploys.
- Deploy health-check rollback fires twice: stop and inspect journal boot errors (fail-loud).
