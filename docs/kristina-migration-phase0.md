# Kristina Migration — Phase 0 Report

Date: 2026-05-18 (Sydney UTC+10)
Branch: not yet — Phase 0 is read-only
Author: pre-migration diagnostics

## 1. Confirmed root cause of 2026-05-18 05:54 UTC failure

The "Sorry, I couldn't process that. Please try again." reply was **NOT** an Atlas timeout (my initial hypothesis). The actual failure was:

```
2026-05-18T05:54:29.798Z [Kristina] ERROR: Brain error:
  Error: Brain query failed: Claude Code returned an error result:
  API Error: 400 {"type":"error","error":{"type":"invalid_request_error",
  "message":"You have reached your specified API usage limits.
  You will regain access on 2026-06-01 at 00:00 UTC."},
  "request_id":"req_011Cb9WuSWGJ57udzkaTxe3N"}
```

The Anthropic workspace **spending cap** has been hit. Same error appeared at 05:11:13 UTC for an earlier message in the same session. All user-message brain calls are failing identically until the cap is raised (or June 1 resets it).

**User action item (not in this plan's scope):** raise the workspace spending cap at console.anthropic.com. User confirmed they will do so today.

## 2. Brain provider mapping

- Config: `bots/kristina.yaml` → `brain.provider: claude`, `brain.model: claude-opus-4-6`
- Code: `packages/core/src/brain.ts` → `@anthropic-ai/claude-agent-sdk` → spawns Claude Code subprocess via `query()`
- There is ALSO a `brain-cli.ts` (used by `provider: claude-cli`) which shells out to `claude -p` directly. Both end up at Claude Code; only the wrapper differs.

For our purposes: `provider: claude` is the right choice (Agent SDK gives MCP tool support, structured turn loop, cost reporting). No change needed.

## 3. Standalone state

- `kristina-bot.service`: `inactive` + `disabled` since 2026-05-09 21:46 UTC (clean SIGTERM). 9 days dead.
- Local source repo `/Users/Mark/Documents/dev/bots/kristina-bot`: independent git repo (not a submodule), **no remote configured**.
- **Uncommitted local changes** in standalone (never deployed): resilience improvements worth porting.
  - `deploy.sh` — openclaw → acemagic target rename (purely deployment, not relevant to botforge)
  - `src/db/index.ts` — `closeDb` is now idempotent (sets `db = null!`)
  - `src/index.ts` — `ready` flag, polling-aware health endpoint (returns 503 if not ready/polling), crash handlers (`uncaughtException`, `unhandledRejection`) that close DB before exit
  - `src/scheduler/cron.ts` — heartbeat ping (every 5 min, posts to `HEALTHCHECK_PING_URL` and `…/fail`)
  - `src/telegram/bot.ts` — 60s sliding-window polling-error tracker, exits process after 15 errors; resets on successful message/callback; deductionCallbacks GC every hour
  - `src/resilience.test.ts` — new vitest covering closeDb idempotency + polling error counter

**Decision (user confirmed):** port these patterns into the botforge framework (Phase 1) so all bots benefit.

## 4. Env audit (`/opt/botforge/.env` vs `/opt/kristina-bot/.env`)

Present in both: `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `ATLAS_SYNC_URL`, `ATLAS_SYNC_KEY`, `TELEGRAM_CHAT_ID`.

**Missing from botforge `.env`** (will need to add before Phase 3):
- `ADMIN_USER_ID` — needed for `/register` permission gate (line check in `commands/register.js`)
- `HEALTHCHECK_PING_URL` — optional; the ported heartbeat ping cron skips silently if unset
- `SPOK_DEFAULT_FUND_ID`, `SPOK_READ_FUND_IDS` — referenced in standalone CLAUDE.md but NOT in `config.ts` Zod schema. Appears to be vestigial — confirm before adding.

## 5. Live botforge state

- Service `botforge-kristina`: `active` + `enabled`. PID 1406, port 8087 bound on `127.0.0.1`.
- `Kristina.db` (framework — interaction-log, conversation_history, sessions, token_usage): 90 conversation rows, 14-day TTL configured.
- `Kristina-tools.db` (bot domain): 6 OPEN / 4 DONE / 23 ARCHIVED tasks.

### Tables present in live `Kristina-tools.db`

`callback_tracking`, `column_cache`, `message_refs`, `registered_chats`, `task_attachments`, `task_subtasks`, `tasks`

### Tables MISSING (needed for full parity)

- `deductions` — needed for `record_deduction`, `get_balance`, nudge cron
- `nudge_log` — needed for `nudge_send` / `nudge_deductions` crons (cap deductions $5/day)

## 6. Botforge kristina structure (what exists / what's missing)

Existing in `/Users/Mark/Documents/dev/botforge/bots/kristina/`:

| Dir | Files |
|---|---|
| `tools/` | create_task, delete_task, mark_done, query_board, update_task (**5**) |
| `cron/` | auto-archive, conversation-cleanup, daily-digest, done-notification, sync-retry (**5**) |
| `commands/` | done, filter, help, passive, register, status (**6**) |
| `callbacks/`, `context/`, `lib/`, `lifecycle/` | present |

To add for full parity (per Phase 2):

| Bucket | New items |
|---|---|
| Tools | `cancel_task`, `hand_off`, `record_deduction`, `get_balance`, `attach_photo` (**5**) |
| Crons | `deadline-expiry`, `deadline-followups`, `decay-check`, `nudge-send`, `nudge-deductions`, `healthcheck-ping` (**6** incl. opt) |
| Commands | `balance` (**1**) |
| Libs | `working-hours.js`, `decay.js`, possibly `pending-photos.js` (depending on Telegram adapter native media handling) |

## 7. Atlas-client status

`bots/kristina/lib/atlas-client.js` is **already mature**: 3-failure / 15-min circuit breaker (matches standalone), 10s default timeout (30s for image payloads), AbortController, single retry on non-auth failures, attachments support, 3-phase `retrySyncPending` (unsynced tasks → unsynced attachments → unsynced subtasks). **Phase 2.6 work is mostly already done.**

## 8. Multi-user / registered_chats

`commands/register.js` is implemented and wired. Standalone has 3 registered chats in DB: Sara (`-5211981099`), Hendrik (`-5117614003`), Mark (`-5231435029` auto-registered). Multi-user works in botforge already; ensure these chats are carried over (or re-registered) post-cutover.

## 9. Open standalone tasks (snapshot)

18 OPEN tasks in `/opt/kristina-bot/data/kristina.db` — all dated before 2026-05-15. Hand-review needed for any still-relevant work (see Phase 2a). Captured at `/tmp/standalone-open-tasks.txt` on acemagic.

## 10. Backups taken

- `acemagic:/opt/botforge/data/Kristina.db.backup-20260518` (root-owned)
- `acemagic:/opt/botforge/data/Kristina-tools.db.backup-20260518` (root-owned)
- `/Users/Mark/Documents/dev/botforge/backups/Kristina-pre-migration-20260518.db` (local)
- `/Users/Mark/Documents/dev/botforge/backups/Kristina-tools-pre-migration-20260518.db` (local)

## 11. Plan deltas

What changed vs the v2 plan after Phase 0 findings:

1. **Root cause is API spending cap, not Atlas timeout.** Phase 1's structured-error work + active probe (Phase 4) still applies — they would have surfaced today's failure as `rate_limited` instead of opaque "couldn't process". No code changes needed beyond what Phase 1 already plans.
2. **atlas-client.js Phase 2.6 work mostly done already** — only delta needed: ensure existing `getItems` error path returns helpful narration, and verify it's reachable from each tool.
3. **Phase 1 scope grew** — add the standalone's resilience patterns to the framework (crash handlers, polling-error watchdog, ready/polling health gates). Adds maybe ~30 min.
4. **Schema migrations needed for Kristina-tools.db:** add `deductions` + `nudge_log` tables. The other 5 tables we'd planned to add already exist.
5. **Standalone source repo has no git remote.** Phase 3 archive is just a local rename — no remote cleanup needed.
6. **registered_chats data is in standalone DB** — need to either re-register Sara + Hendrik post-cutover via `/register` command, OR copy the rows into botforge's Kristina-tools.db at cutover.

## 12. Next steps

Proceed to Phase 1 (framework hardening on branch `fix/runtime-structured-errors`).
