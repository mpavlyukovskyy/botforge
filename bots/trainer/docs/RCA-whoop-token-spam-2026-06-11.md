# RCA: Trainer bot Whoop token-refresh failure + all-day alert spam (2026-06-11)

## Symptom
"⚠️ Trainer alert: Whoop token refresh failed: 400 invalid_request …redirect_uri…" to Mark's
trainer Telegram chat every 5 minutes, ~267 alerts in 24h.

## Root cause (definitive, evidence-backed)

**The stored Whoop refresh token died during Whoop's Cloudflare 503 outage window
(Jun 10 23:35 – 00:00 EDT) and has been dead ever since. The bot retried the dead token
every 5 minutes forever and alerted on every attempt.**

Timeline (journalctl + live DB on acemagic):
- Jun 10 20:15 / 21:05 / 21:55 / **22:45 EDT** — real, successful refreshes. The 22:45 one is the
  LAST time `oauth_tokens` was written (DB `updated_at` = 2026-06-11 02:45:00 UTC).
- Jun 10 23:35 → 00:00 EDT — six refresh attempts hit **Cloudflare 503** (Whoop outage). During this
  window Whoop's OAuth server (ORY Hydra) most plausibly processed a refresh (rotating the token)
  while the 503 ate the response — a rotation **lost-update**. Whoop rotates refresh tokens on every
  use, old token immediately invalid, no grace period; reuse detection revokes the whole grant chain.
- Jun 11 00:05 EDT onward — **every** refresh returns permanent 400 `invalid_request`. The
  `redirect_uri` hint is fosite/Hydra's *generic* `ErrInvalidRequest` boilerplate, not a real
  redirect_uri problem (ory/hydra#3442). Stored refresh_token is non-empty (len 87) but dead.
- The three daytime "Whoop token refreshed" log lines (05:00:02, 12:00:02, 18:00:02) are **phantom
  successes**: the lock-contention path in `whoop-client.js` sleeps exactly 2000ms, returns the stale
  stored access token, and `token-refresh.js` logs "refreshed" unconditionally. No HTTP, no DB write.

Recovery from a dead Whoop refresh token requires **full user re-authorization** (browser consent).
There is no API-side recovery.

## Why it spammed all day (the design failures)

1. **No transient/permanent error taxonomy.** A permanently-dead token (400 invalid_grant/
   invalid_request) is retried identically to a network blip, forever.
2. **No alert dedup/cooldown/terminal state.** `cron/token-refresh.js` → `alertUser()` on every
   failure, every 5 min, with `expires_at <= now+600` permanently true.
3. **Phantom success logging** masked the outage for 18+ hours of "refreshed" lines.

## Contributing & latent bugs (would cause the NEXT incident)

4. **TOCTOU refresh-token replay**: `refresh_token` is read *before* the lock and replayed after lock
   handoff — if another caller rotated meanwhile, we present the old token = real reuse = Hydra
   revokes the whole chain. (whoop-client.js:52, token-refresh.js:28-39)
5. **No fetch timeout + 30s lock auto-steal**: a refresh hung >30s lets a stealer refresh the SAME
   token concurrently (true reuse); recovery-fetch's 12s `Promise.race` rejects without aborting, so
   an orphaned refresh can complete later and **stale-overwrite** a newer token (`upsertOAuthToken`
   is unconditional, no CAS).
6. **Lock-loser returns a known-expired access token** after a fixed 2s sleep → downstream 401s.
7. **Cron collisions**: every Whoop-touching cron lands on a 5-minute boundary, same minute as the
   `*/5` token_refresh; the framework runs different cron jobs fully concurrently (per-job CAS only).
8. **Intra-cron parallelism**: recovery-fetch and daily-sync fire 3 parallel `getAccessToken` chains.
9. **Non-canonical refresh body**: sends full multi-scope `scope` list; Whoop docs specify
   `scope: 'offline'` only. Not the cause, but deviates from documented form.
10. **Re-auth is a manual dance**: `whoop-auth.js` runs on the Mac, writes a LOCAL SQLite file; token
    must be hand-carried to acemagic. Live DB is `/opt/botforge/data/Trainer-trainer.db` (cwd-relative
    path + `WorkingDirectory=/opt/botforge`), NOT `bots/trainer/data/` (stale April leftovers there).
11. **Migration gap**: `locked_at` exists only via `CREATE TABLE IF NOT EXISTS`; no `ALTER` fallback.
12. **Double-wrapped error text** ("refresh failed: refresh failed:") in alerts.

## What was ruled out
- Missing WHOOP_CLIENT_ID/SECRET (set in service env, worked 4× on Jun 10 evening).
- Stale deployed code (all 6 relevant files byte-identical local↔server; `dist/` is the stale copy).
- redirect_uri misconfiguration (generic Hydra hint; redirect_uri isn't part of refresh requests).
- Empty stored refresh_token (len 87).
- Another process touching the token (only botforge-trainer references Whoop).
