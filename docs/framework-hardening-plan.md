# Botforge Framework Hardening — All Tiers

*Draft plan, 2026-05-24. Pending red-team review before execution.*

## Context

Audit by 6 parallel agents (3 internal: bot scopes, framework gaps, production pain history; 3 external: AI agent frameworks, chatbot reliability, event-driven patterns) converged on the same systemic gaps in botforge. This plan addresses all of them in 4 sequenced tiers.

**The shared bug that motivated this**: every bot in the zoo independently rediscovers the same reliability primitives (callback idempotency, DLQs, retry loops, allowlists, db boilerplate). Alfred shipped an inbox pattern this week; lifting it into botforge fixes 7 bots in one move and unlocks the rest of the hardening work.

## Bots affected

### In scope — all 7 botforge bots inherit Tier 1-3 changes via framework upgrade

| Bot | Service | Port | Source | Owner-criticality |
|---|---|---|---|---|
| **Kristina** | `botforge-kristina` | 8087 | `bots/kristina/` | HIGH — Mark's daily driver, $1/task financial decay model |
| **Maia** | `botforge-maia` | 3100 | `bots/maia/` | HIGH — Kauri Partners deal sourcing, scraped data + broker outreach |
| **Atlas** | `botforge-atlas` | 8086 | `bots/atlas/` | MEDIUM — Mark+Hendrik shared task tracker |
| **Harry** | `botforge-harry` | 8082 | `bots/harry/` | HIGH — NZVC LP reply triage, customer-facing email drafts |
| **Trainer** | `botforge-trainer` | 8092 | `bots/trainer/` | LOW — cron-heavy, no conversational brain (`dm_mode: ignore`) |
| **Chief-of-Staff** | `botforge-chief-of-staff` | 8091 | `bots/chief-of-staff/` | HIGH — Science Corp email triage + meeting prep |
| **Babushka** | `botforge-babushka` | 8085 | `bots/babushka.yaml`, source at `bots/babushka-stories/` | MEDIUM — audio pipeline, Mark-only DM |

Three test bots (`test-echo`, `test-claude`, `test-full` on ports 9001-9003) are smoke configs used for framework changes before real deploys.

### Out of scope for this plan

| Bot | Status | Reason |
|---|---|---|
| **Alfred / taskbot** | Standalone, has its own inbox + emoji reactions | Migration into botforge is a separate larger decision (LunchDrop placement code, dashboard, custom schema). Keeps its own ~150 LOC inbox copy until/unless that migration happens. |
| **Agenda-bot** (standalone) | Predecessor to Atlas, replaced | Dead code in `/Users/Mark/Documents/dev/bots/agenda-bot/`. Recommend deletion in Tier 3 hygiene. |
| **NZVC-LP-bot** (standalone) | Predecessor to Harry, replaced | Dead code in `/Users/Mark/Documents/dev/bots/nzvc-lp-bot/`. Recommend deletion in Tier 3 hygiene. |
| **Seeking-bot** | Not yet deployed | LinkedIn outreach automation. When ready to deploy, it'll inherit all framework upgrades automatically. |

---

## Tier 1 — Phase 1 Hardening (~5-7 days, one branch)

Single commit branch in botforge. Each item below is one PR-shaped chunk; all five land before any production deploy.

### T1.1 Inbox skill — `@botforge/skill-telegram-inbox`

**Source of truth pattern**: port from Alfred's `src/telegram/inbox.ts` (~150 LOC) + the `processUpdate` interceptor.

**Where it lives**:
- New package `packages/skills/telegram-inbox/` following the `interaction-log` package shape
- Schema migration in `packages/storage/sqlite/` exposing `TELEGRAM_INBOX_MIGRATIONS` alongside the existing `CONVERSATION_HISTORY_MIGRATIONS`
- Adapter wiring via new `TelegramAdapter.setInbox(inbox)` method called by runtime after skill init
- Runtime auto-detects when `platform.type === 'telegram'` and adds to `SKILL_INIT_ORDER`

**Key decisions**:
- Default-on (matches Alfred's behavior; opt-out via `platform.inbox.enabled: false` in YAML)
- One inbox table per bot, in the existing `data/<Bot>.db` (NOT a new DB file)
- Replaces the in-memory `seenUpdateIds` ring buffer with persistent SQLite-backed dedupe (functional superset)
- `resetOrphanedOnBoot()` runs in skill `init()` before adapter starts

**Tests**: port Alfred's `inbox.test.ts` verbatim, plus an integration test using `mockAdapter` (see T1.5).

**Failure mode prevented**: silent message loss on bot crash or hung handler (the Sara-message regression).

### T1.2 Polling-error backoff in TelegramAdapter

**Problem**: today an `EAI_AGAIN api.telegram.org` DNS failure → `process.exit(1)` → systemd restart in 5s → DNS still down → repeat. Observed 8x restarts in 90 minutes today.

**Fix**: in `packages/adapters/telegram/src/index.ts`, before the 15-errors-in-60s watchdog, add an exponential backoff for transient network errors (EAI_AGAIN, ECONNRESET, ETIMEDOUT): pause polling 5s → 15s → 60s → 5min before triggering process exit. Keep the hard 15/60s watchdog for genuine bugs.

**Touches**: ~30 LOC in the existing adapter; nothing new exported.

**Failure mode prevented**: restart-storm during home-internet DNS flakes.

### T1.3 Structured JSON logs with request_id propagation

**Library**: Pino, the de facto Node logger in 2026 (7× faster than Winston, native JSON, zero overhead when not consumed).

**What changes**:
- Replace `createLogger` in `packages/core/src/skill.ts` (currently emits `[BotName] LEVEL: msg`) with Pino instance configured to write JSON to stdout
- Mint a `request_id` at adapter ingress (recommended: `tg:{chat_id}:{update_id}` — naturally unique, debug-friendly)
- Pass `request_id` through every async boundary: handler → tool execution → outbound HTTP → DB writes. Pattern: AsyncLocalStorage with a small `ctx.log.child({ request_id })` helper.
- All log lines get `{ts, bot, level, msg, request_id?, chat_id?, span?}` fields.

**Backward compat**: keep human-readable output by piping through `pino-pretty` in `LOG_PRETTY=true` dev runs. systemd journal will start receiving JSON; `journalctl ... | jq` becomes the new tail pattern.

**Touches**: `packages/core/src/skill.ts` (logger factory), `packages/core/src/runtime.ts` (mint request_id at message boundary, propagate via AsyncLocalStorage), all `ctx.log` callsites (no API change if logger interface stays the same).

**Failure mode prevented**: 45-minute archaeology sessions to trace a dropped message across logs + interactions table + Atlas sync output.

### T1.4 Per-bot Anthropic budget cap with early warning

**Problem motivating this**: 2026-05-18 Kristina outage was an Anthropic workspace spending cap hit globally; every bot in the workspace got the same opaque "Sorry, I couldn't process that" for 9 days before root cause was found.

**Fix**:
- New YAML field: `brain.budget_usd_per_day: 5.0` (per-bot daily cap)
- `token-tracker` skill (already exists, already records cost) gains a `getDailySpend()` API
- Brain processor checks: at request time, if `daily_spend >= 0.8 * budget` → DM admin user "yellow" warning (once per day). If `daily_spend >= budget` → hard refuse with structured error `budget_exhausted` instead of failing on the Anthropic API call.
- Cap resets at UTC midnight (or `TIMEZONE` if set).
- Workspace-wide cap (the May 18 cause) is separate and harder to catch — but per-bot caps isolate blast radius: one runaway bot doesn't exhaust the whole pool.

**Touches**: `packages/skills/token-tracker/` (new query), `packages/core/src/runtime.ts` (budget check + structured error), `packages/core/src/schema.ts` (YAML field).

**Tests**: budget hit → structured error, 80% threshold → DM fires once per day not on every message, midnight reset works.

**Failure mode prevented**: Mark not noticing for 9 days that an entire bot has been silently apologizing because of billing.

### T1.5 Decompose `runtime.ts` god module

**Problem**: `packages/core/src/runtime.ts` is 1161 lines, 24 `as any` casts to skills, contains `startBot()` which does config loading, module registration, skill init, message routing, error classification, callback dispatch, lifecycle, shutdown. Every change to anything risks everything.

**Fix**: extract without behavior change:
- `packages/core/src/brain-processor.ts` — the 330-line `createBrainProcessor` closure
- `packages/core/src/reception.ts` — `group_mode`/`dm_mode`/keyword/pattern reception rules (currently inlined in runtime.ts:922-944, also partially in the dead `passive-detection` skill)
- `packages/core/src/skill-loader.ts` — `detectSkills`, `SKILL_INIT_ORDER`, skill init/destroy lifecycle
- `packages/core/src/module-loader.ts` — convention-directory loader (`tools/`, `commands/`, etc.)
- Keep `runtime.ts` as the thin orchestrator (~300 LOC).

**Also**: type `inst.store: Map<string, unknown>` as a `BotStore` interface with the 7 known keys (`_lastError`, `_lastMessageProcessedAt`, `_toolCallLog`, `_atlasCircuitState`, `eventBus`, `toolRegistry`, `postResponse`). Removes 20+ `as any` casts.

**Why this is in Tier 1, not Tier 3**: every other change in this plan touches `runtime.ts`. Doing the decomposition first means later changes are isolated edits to small files instead of risky surgery on a 1161-line module.

**Tests**: write a `MockAdapter` (exported from `@botforge/core/testing`) and add the first runtime integration test: full message round-trip through reception → chat-lock → brain → response → log. ~200 LOC of test code.

**Touches**: lots — but it's MOVING code, not rewriting. Diffs should be mostly mechanical.

**Failure mode prevented**: every future change becoming a leap of faith. Establishes the test harness Tier 2 and 3 depend on.

### Tier 1 deliverable

One PR-style branch covering all 5 items, ~800 LOC net, ~5-7 working days. Includes the `MockAdapter` test harness as a deliverable for everything downstream.

---

## Tier 2 — Phase 2 (~5-7 days, after Tier 1 soaks 3-5 days)

### T2.1 Outbox skill — `@botforge/skill-telegram-outbox`

**Problem**: today `bot.sendMessage` is called directly inside the handler. If the process dies between "LLM responded" and "Telegram received", the user sees nothing.

**Pattern** (microservices.io transactional outbox + the inbox sibling):
- Table `tg_outbox(id, chat_id, payload, status, attempts, last_error, created_at, sent_at)`
- Handlers write intent (`status='pending'`) in the same SQLite transaction as the state change (e.g., `tasks` row write + outbound `sendMessage` intent both commit or neither)
- Separate cron worker (1s interval) drains `pending` rows with exponential backoff
- After N attempts (default 5) → `status='failed'` → goes to DLQ (T2.3)

**Touches**: new skill, ~250 LOC. Modify all `adapter.send()` callsites in runtime to write outbox first (`outbox.enqueue(...)`) instead of calling adapter directly.

**Failure mode prevented**: "agent decided, user never received" loss class.

### T2.2 AbortController + per-stage timeouts

**Pattern** (2026 industry default):
- Per-tool call: 20s timeout (Anthropic-side via SDK + AbortSignal)
- Per-LLM call: 45s timeout
- Per-outbound HTTP (Atlas sync, etc.): 10s timeout
- All composed via `AbortSignal.any([timeout, parent])` so a parent abort cascades

**Where it lands**: `packages/core/src/brain-processor.ts` (after T1.5 extracted it). Pass `AbortSignal` through to the Anthropic SDK call (`anthropic.messages.create({ signal })`) and to each tool's `execute(args, ctx)` signature.

**Bot-author API change**: tools that do I/O should accept `ctx.signal` and pass it to their HTTP clients. Existing tools without that param keep working (signal just isn't propagated).

**Touches**: `brain-processor.ts`, the Anthropic wrapper, tool execution path. ~200 LOC.

**Failure mode prevented**: the today's "polling stale for 1412s" pattern — a hung LLM tool call held up the whole process. With per-stage timeout, hung calls fail fast and the next message processes normally.

### T2.3 Unified DLQ skill — `@botforge/skill-dlq`

**Problem**: 5 bots currently have bespoke `dead_letter` / `sync_failures` / `sync_retry_state` tables with 5 different schemas, retry logic, and operator UX (mostly: there is no operator UX).

**Skill**:
- One table `dlq(id, kind, payload, error, occurred_at, attempts, status, replayed_at)` per bot
- API for handlers + tools: `ctx.dlq.add(kind, payload, error)`
- Admin UI page in the bot's existing dashboard (`/admin/dlq`): list, view, retry (re-run handler), discard
- Alert when `pending` count > 5 (Telegram DM to admin)

**Migration**: existing bespoke DLQ tables stay — each bot's `sync-retry` cron continues to drain them. New code goes to the shared DLQ. Migrate bots one by one in later cleanup.

**Failure mode prevented**: silent loss during third-party API outages.

### T2.4 `withCallbackIdempotency()` primitive

**Problem**: 3 bots (Alfred placer, NZVC-LP approval flow, Kristina Hevy double-tap) independently rediscovered the same callback-double-tap bug in the last 30 days.

**Fix**: small primitive exported by core:
```ts
async function withCallbackIdempotency<T>(
  callbackQueryId: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | { skipped: 'duplicate' }>
```
Uses SQLite-backed dedupe (~5 min TTL) keyed on Telegram's `callback_query.id`. Wrap any callback handler in this and tap-tap-tap stops causing double-effects.

**Touches**: `packages/core/src/callbacks.ts` (new file), wire into existing callback dispatch. Each bot's callback handlers can opt in by wrapping.

**Tests**: tap-during-tap test, expired-TTL test, concurrent-process test (single-host so easy).

### T2.5 Healthchecks.io heartbeat skill — `@botforge/skill-heartbeat`

**Problem**: Kristina has a bespoke `acemagic:/opt/health-probes/kristina-probe.sh` cron. The other 6 bots have no active health monitoring.

**Fix**: skill that pings a configured Healthchecks.io UUID (free tier covers 20 checks) on:
- Successful poll loop tick (every 60s)
- Successful cron execution (per-cron-job UUID)

Healthchecks.io handles paging, grace periods, history, escalation. Replaces the bash script with one YAML field per bot:
```yaml
health:
  heartbeat:
    poll_url: https://hc-ping.com/<uuid-for-poll>
    cron_urls:
      daily_digest: https://hc-ping.com/<uuid-for-digest>
```

**Touches**: new skill ~80 LOC. Per-bot YAML configuration. One-time setup of Healthchecks.io account.

**Failure mode prevented**: silent bot death (Mark not noticing a bot has been crashed for hours/days).

### Tier 2 deliverable

Five PR-shaped changes, ~800 LOC, ~5-7 days. Deployed bot-by-bot in the order from the rollout plan below.

---

## Tier 3 — Hygiene (~3-4 days, anytime)

### T3.1 Delete vaporware schema surface

In `packages/core/src/schema.ts`, remove:
- `platform.type: slack | email | web | headless` — runtime throws on these; misleading to bot authors
- `platform.communication.subscriptions` — `packages/bus/src/` is an empty directory
- `pipelines:` — no runtime consumer
- `behavior.guardrails`, `.escalation`, `.availability`, `.onboarding`, `.webhooks`, `.i18n`, `.fallback` — runtime explicitly warns "not yet enforced"

Either delete or finish implementing each. Default: delete. ~80 LOC removed.

### T3.2 Standardize task-bot tool surface

Three bots (Kristina, Atlas, Alfred-if-it-ever-migrates) reimplement `create_task` / `update_task` / `mark_done` / `query_board` / `delete_task` with slightly different bodies pointing to slightly different DB layers (`atlas-client.js` vs `spok-client.js` vs `task-db.js`).

**Fix**: framework-provided tool pack `@botforge/tools-tasks` that bots opt into. Bot YAML declares the backend:
```yaml
tools:
  - type: task-pack
    backend: spok       # or atlas-sync or local
    config: { sync_url: ..., sync_key: ... }
```
Tool pack ships standard schemas + execute() implementations.

**Touches**: new package. Deletes ~400 LOC of duplicate tool code across 3 bots.

### T3.3 Type `inst.store` god bag

After Tier 1 decomposition, also formalize:
```ts
interface BotStore {
  lastError?: { class: string; message: string; ref: string; ts: string };
  lastMessageProcessedAt?: number;
  toolCallLog?: ToolCallLog[];
  atlasCircuitState?: CircuitState;
  eventBus?: EventEmitter;
  toolRegistry: ToolRegistry;
  postResponse?: (msg: OutgoingMessage) => Promise<void>;
}
```
Removes 20+ `as any` casts. Compile-time safety for the bag.

### T3.4 DNS resilience on acemagic

Install `dnsmasq` or `unbound` with `1.1.1.1` + `8.8.8.8` + `9.9.9.9` upstream, 5-min cache. Most ISP DNS flakes become invisible. Infrastructure change, not code. ~20 min one-time setup. Documented in `infra/acemagic-setup.md`.

### T3.5 Delete dead standalone bots

`/Users/Mark/Documents/dev/bots/agenda-bot/` (replaced by Atlas) and `/Users/Mark/Documents/dev/bots/nzvc-lp-bot/` (replaced by Harry) are dead trees. After confirming nothing references them: delete.

### T3.6 Single shared SQLite handle per bot

Currently each skill opens its own `new SqliteStorage` to the same `data/<Bot>.db` file. Multiple `Database` handles to one file works (WAL mode) but is wasteful. After Tier 1, pass `ctx.db` (single handle) from runtime through `SkillContext`. Each skill uses that handle for its tables.

**Touches**: skill interface change. All 14 skills migrated to use `ctx.db` instead of `new SqliteStorage()`. Mostly mechanical.

### Tier 3 deliverable

Six smaller cleanups, ~400 LOC removed net, ~3-4 days spread out. Do anytime after Tier 1+2 land cleanly.

---

## Tier 4 — Explicitly NOT doing (with rationale)

Documented here so future Claudes don't keep reproposing them.

| Idea | Why skip for now |
|---|---|
| Migrate to Temporal / Inngest / Restate | Overkill at 8 bots × 5 users. Revisit if Kristina/Maia start orchestrating 10+ chained LLM calls per turn or if multi-hour workflows appear. |
| Webhook mode via Tailscale Funnel | Adds dependency on Funnel availability for ingress. Polling + inbox already gives at-least-once at this scale. Revisit if usage grows past ~1k DAU. |
| OpenTelemetry distributed tracing | Payoff at 5+ services; you have 1 process per bot. Pino + request_id (T1.3) gives 90% of the value with grep. |
| NATS / Redis Streams for inter-bot messaging | Wrong scale. `event-bus` skill (intra-process EventEmitter) is enough. Revisit if multi-host. |
| Move bots to managed PaaS (Fly.io / Railway) | Conscious tradeoff: home host has lower cost + lower latency at the price of single-point-of-failure. Suggest moving Kristina ONLY (highest-stakes bot, $3/mo on Fly) as a hedge. |
| grammY migration from `node-telegram-bot-api` | Real cost (every handler signature change) for marginal benefit. The TelegramAdapter has hard-earned scar tissue we'd lose. Revisit if NTBA stops getting security updates. |
| Multi-region fail-over | Conscious tradeoff. Single home host is acceptable for personal bot fleet. |
| Slack / Discord adapter | Build only when actually needed. |

---

## Sequencing & dependencies

```
Tier 1 (must do as one branch)
   ├─ T1.5 Runtime decomposition  ← prerequisite for everything
   ├─ T1.3 Pino logs               ← used by all subsequent items
   ├─ T1.2 Polling backoff         ← independent
   ├─ T1.1 Inbox skill             ← independent (already proven on Alfred)
   └─ T1.4 Budget cap              ← uses token-tracker (already exists)

   [soak 3-5 days across all 7 bots]

Tier 2 (do as a second branch)
   ├─ T2.1 Outbox                  ← uses T1.5 brain-processor decomposition
   ├─ T2.2 AbortController         ← uses T1.5 brain-processor; uses T1.3 logs
   ├─ T2.3 DLQ                     ← uses T1.3 logs
   ├─ T2.4 Callback idempotency    ← independent
   └─ T2.5 Healthchecks heartbeat  ← independent

   [soak 3-5 days]

Tier 3 (anytime, smaller chunks)
   ├─ T3.1 Delete vaporware
   ├─ T3.2 Standardize task tools
   ├─ T3.3 Type inst.store
   ├─ T3.4 DNS resilience
   ├─ T3.5 Delete dead bots
   └─ T3.6 Single SQLite handle
```

---

## Per-bot rollout order (applies to Tier 1 deploy + Tier 2 deploy)

Established by Agent B in the prior survey, ordered by stakes:

1. **test-echo / test-claude / test-full** — smoke-test the framework changes
2. **Babushka** — Mark-only DM, low message volume, voice pipeline
3. **Trainer** — Mark-only, cron-heavy, no conversational brain (low Telegram surface)
4. **Harry** — moderate volume, automated replies, failure mode is "missed reply" (recoverable)
5. **Maia** — Mark-only user-facing
6. **Atlas** — Mark+Hendrik group chat (multi-user test of reception)
7. **Chief-of-Staff** — Science Corp, business-critical, single user
8. **Kristina** — multi-user (Sara/Hendrik/Mark), financial model writes, LAST because most surface area + recent migration scars

Each deploy: `pnpm botforge deploy <name>` → wait for health check → verify `/api/health` shows new fields (e.g. `inbox: {...}`) → send one test message → soak 30 min before next bot.

---

## Test strategy

### Framework-level tests (land with Tier 1)
- `MockAdapter` exported from `@botforge/core/testing` (deliverable in T1.5)
- Integration test for `startBot` covering full message round-trip
- Per-skill unit tests for new skills (inbox, dlq, heartbeat, outbox)
- Migration idempotency tests (`tg_inbox` add to fresh + existing DBs)
- Concurrency tests where applicable (callback idempotency)

### Per-bot canary tests (run after each deploy)
- Send one test message → verify it reaches the bot's existing tools
- Check `tg_inbox` table exists + got the message row + status='done'
- Check `/api/health` shows new fields
- Tail journal for any new error patterns

### Production canary period
- 30 min between bot deploys
- 3-5 days soak after each tier completes
- Healthchecks.io alerts on any bot dropping during soak

---

## Rollback procedures

### Per-bot rollback
`pnpm botforge deploy` already supports atomic `.old/.new` swap with health-check verification + auto-rollback if start fails. Doesn't cover post-startup misbehavior — for that, manually `mv dist dist.failed && mv dist.old dist && systemctl restart botforge-<name>`.

### Schema rollback
All new tables (`tg_inbox`, `tg_outbox`, `dlq`) are forward-compatible: old code ignores them; rolling back the framework doesn't break the bot, the tables just go unused. Don't `DROP TABLE` on rollback.

### Feature kill switches per skill
Each new skill gets a YAML opt-out (`inbox.enabled: false`, `outbox.enabled: false`, etc.). Worst-case rollback for a misbehaving skill is editing the bot's YAML and restarting — no redeploy needed.

### Framework version rollback
If a Tier 1 change breaks broadly, pin all 7 bot deploys to the previous botforge framework version via `pnpm botforge deploy --version=<prev>`. (NB: this is NOT a feature today — Tier 3 hygiene could add it.) For now, rollback = `git checkout <prev-commit>` in the framework + redeploy each bot.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| **Tier 1 runtime decomposition introduces subtle behavior change** | Land first; soak on test bots before any prod deploy. Integration test catches the obvious. Manual smoke test of Kristina's most-used flows. |
| **Pino JSON output breaks human `journalctl` reading habits** | `pino-pretty` in dev; document the `journalctl ... \| jq` pattern for prod. May add a `LOG_FORMAT=pretty` env override. |
| **Anthropic budget cap (T1.4) hits during legitimate usage** | Cap default high (e.g. $5/day per bot, ~10× normal usage). Easy YAML override per bot. Yellow warning at 80% gives advance notice. |
| **Healthchecks.io free tier limit (20 checks)** | 8 bots × 1 heartbeat + 8 bots × 2 crons = 24. Just over the limit. Either prioritize which crons get heartbeated, or pay $5/mo for 25-check tier. |
| **Bot DB migrations during deploy lock the file briefly** | WAL mode means readers aren't blocked. Migration is one CREATE TABLE + 1-2 ADD COLUMN — millisecond-level lock. Negligible. |
| **Tier 2 outbox + existing per-bot sync_retry crons could double-send** | New code writes to `tg_outbox`. Existing bot sync_retry tables continue draining their bespoke queues. Migration cleanup in Tier 3 — until then, no conflict. |
| **Tier 3.6 shared SQLite handle could expose concurrency bugs** | Skills currently each have their own handle (forgiving). Switching to one handle makes WAL contention visible. Mitigation: test with KristinaDB under concurrent simulated load before rolling out. |

### Open questions for Mark

1. **Should Alfred eventually migrate INTO botforge?** Out of scope for THIS plan but related. Implication: it'd get the inbox/outbox/etc. for free, but loses the customizations (LunchDrop dashboard, custom port). Recommend deferring until botforge proves Tier 1+2 are stable.
2. **Healthchecks.io paid tier vs prioritize crons?** $5/mo for 25 checks fits all 8 bots + key crons. Alternative: self-host Uptime Kuma on acemagic (but acemagic IS the thing being monitored 😬).
3. **DNS caching on acemagic — `dnsmasq` or `unbound`?** Either works. `unbound` is more robust; `dnsmasq` is simpler. Default: dnsmasq.
4. **Per-bot Anthropic budget defaults?** Suggest $5/day for high-stakes bots (Kristina, Maia, Harry, Chief-of-Staff), $2/day for medium (Atlas, Babushka), $1/day for low (Trainer). YAML override per bot.

---

## Estimated effort + calendar

| Phase | Wall-clock | Net LOC | Risk |
|---|---|---|---|
| Tier 1 | 5-7 working days | +800 LOC | High (runtime touch) |
| Tier 1 soak | 3-5 days | 0 | Low |
| Tier 2 | 5-7 working days | +800 LOC | Medium |
| Tier 2 soak | 3-5 days | 0 | Low |
| Tier 3 | 3-4 working days | -400 LOC net | Low |
| **Total** | **~3 calendar weeks** | **+1200 net LOC** | |

Plus one-off infra work (Healthchecks.io setup, DNS caching, optional Fly.io for Kristina) ~half day.

---

## Definition of done

Plan is "done" when:
- All 7 botforge bots have `tg_inbox` populated for every received message (Tier 1)
- No bot has restarted more than 1x/day on transient network errors (Tier 1 T1.2)
- A simulated bot crash mid-handler results in zero lost messages on restart (Tier 1 T1.1)
- A grep of `request_id=tg:...` across `journalctl -u botforge-*` returns a complete trace for any user message (Tier 1 T1.3)
- A bot whose Anthropic budget is forced low (test config) refuses messages with `budget_exhausted` and DMs admin at 80% (Tier 1 T1.4)
- `runtime.ts` is under 400 LOC; all extracted modules have at least basic tests (Tier 1 T1.5)
- An outbox-failed Telegram message is auto-retried 5x then lands in DLQ visible on `/admin/dlq` (Tier 2)
- A hung tool call is aborted at 20s and the bot continues processing next messages (Tier 2)
- A double-tapped callback executes exactly once (Tier 2)
- Healthchecks.io shows all 7 bots green; one is paused and an alert fires within 10 min (Tier 2)
- `schema.ts` no longer accepts `slack`/`email`/`web`/`headless` platforms (Tier 3)
- `agenda-bot` and `nzvc-lp-bot` source trees deleted (Tier 3)

---

*Next step (per the planning workflow): red-team this draft, iterate, then commit to Phase 1 execution.*
