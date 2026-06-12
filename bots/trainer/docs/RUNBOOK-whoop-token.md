# Runbook: trainer Whoop token

## Quick state check (always -readonly; a root rw open can lock the bot out)
```bash
ssh acemagic "sqlite3 -readonly /opt/botforge/data/Trainer-trainer.db \
  \"SELECT status, dead_reason, datetime(dead_at,'unixepoch') AS dead_at, \
    consecutive_invalid_request, datetime(expires_at,'unixepoch') AS expires, updated_at \
    FROM oauth_tokens WHERE provider='whoop'\""
```
The LIVE DB is `/opt/botforge/data/Trainer-trainer.db` (cwd-relative path + systemd
WorkingDirectory). `bots/trainer/data/` is a decoy — never touch it.

## States
- `active` — normal. The token_refresh cron (minutes 2,7,…,57 UTC) refreshes when <10 min of
  life remain. Log states: `whoop: refreshed | valid-skip | transient-fail (n, reason)`.
- `dead` + `dead_reason=invalid_grant` — Whoop revoked the grant chain (e.g. refresh-token reuse
  detection, or a rotation lost to an outage like the 2026-06-10 Cloudflare 503 window). The bot
  stops calling the token endpoint (except one verification probe per 12h), sends ONE alert with
  reminders (+6h, +24h, daily). **Fix: re-auth (below).**
- `dead` + `dead_reason=invalid_request_x3` — 3 consecutive generic 400s. Same handling; the 12h
  probe self-heals a false positive.
- Config alert ("check WHOOP_CLIENT_ID/SECRET") — credentials problem in `/opt/botforge/.env`;
  re-auth will NOT fix it and the token is NOT dead.

## Re-auth (~3 min, browser on the Mac)
```bash
cd ~/Documents/dev/botforge/bots/trainer && node scripts/whoop-reauth.mjs        # add --watch to follow
```
Installs straight into the live DB over SSH, verifies with the fresh access token, and the bot
picks it up on its next 5-min tick — no restart. Expect the "Whoop token recovered" Telegram
message within ~5 min and a truthful `whoop: refreshed` journal line within ~55 min.

If consent fails at Whoop's portal: check https://localhost:8090/callback is still whitelisted
at developer.whoop.com and the `offline` scope is enabled.

## Liveness (what fires if this breaks tomorrow)
`/opt/health-probes/fleet-watchdog.sh` (cron, every 5 min, alerts Mark's DM 381823289):
- bot-wedged: token dead >1h with no alert sent by the bot;
- staleness: no Whoop recovery score for 72h while the bot isn't alerting.
Kill-test: `WHOOP_DB_OVERRIDE=/tmp/copy.db WHOOP_STALE_HOURS_OVERRIDE=0 TG_DRYRUN=1 /opt/health-probes/fleet-watchdog.sh`.

## Invariants the code maintains (don't regress these)
- Refresh is single-writer: ownership lock (`lock_token`, steal at 120s); refresh token re-read
  INSIDE the lock; success persisted via CAS on the presented token. `INSERT OR REPLACE` is banned
  on oauth_tokens. Tests: whoop-client/whoop-db/whoop-cross-process.
- Never force a refresh from a second process "to check" — rotation + reuse-detection kills the
  chain. Verify with the ACCESS token (`/user/profile/basic`) instead.
- All temporal columns are epoch SECONDS; comparisons never use SQL `datetime('now')`.

## Rollback of the hardening itself
`git revert <merge>` → `pnpm botforge deploy trainer` → restore
`/opt/botforge/bots/trainer.yaml.pre-hardening` → `sudo systemctl restart botforge-trainer`.
Spam resumes (pre-fix behavior). The watchdog whoop check stays — condition (a) goes inert
(old code never sets status), condition (b) staleness remains the outside signal.

## Incident history
2026-06-11: 267 alerts/24h. RCA: docs/RCA-whoop-token-spam-2026-06-11.md. Plan + red-teams:
docs/PLAN-whoop-token-hardening.md, docs/EXECUTION-whoop-token-hardening.md.
