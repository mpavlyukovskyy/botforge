# Botforge migration guide

*Tracks breaking changes per version. Bot authors check here when upgrading.*

## Versioning

Each `@botforge/*` package follows semver:

- **Patch** (`0.0.x`): bug fixes only. Drop in.
- **Minor** (`0.x.0`): new features, no breaking changes to existing contracts. Drop in.
- **Major** (`x.0.0`): breaking changes. Read the migration section.

Workspace packages move in lockstep when changes are cross-cutting (e.g. a new field in `SkillContext` bumps every dependent package's major).

---

## 0.x — unreleased Tier-1 + Tier-2 work (May 2026)

This branch (`feat/framework-hardening-t1`) contains the in-progress Tier 1/2 work documented in `docs/framework-hardening-plan.md`. Not yet on `main`.

### Behavior changes for bot authors

- **`ctx.log` is now a Pino logger** (T1.3). The interface — `log.info(msg, ...args)` — is unchanged. Output is now JSON to stdout; pipe through `pino-pretty` in dev with `LOG_FORMAT=pretty pnpm botforge dev ...`. `journalctl ... | jq` is the production read path.
- **Telegram messages now go through an inbox** (T1.2). Loaded automatically for `platform.type === 'telegram'`. Bot handlers see no API change; the underlying durability guarantee is now at-least-once instead of best-effort.
- **`store.set('toolRegistry'|'eventBus'|'postResponse')`** are still accepted but framework code uses `STORE_KEYS.*` constants for these slots. Bot code may continue to use loose string keys.
- **Cron handlers receive in-flight tracking** (T1.4). To opt into crash recovery, add `replay_on_crash: true` to the cron job's YAML. Default is `false` (no replay) because the framework can't tell whether your handler is idempotent.
- **`brain.budget_usd_per_day`** is a new YAML field (T1.5). Set to refuse Anthropic calls past the cap; default is no cap.

### New surfaces

- `import { withCallbackIdempotency } from '@botforge/core'` — wrap inline-keyboard callback handlers to dedupe double-taps.
- `import { withTimeout, anySignal, TimeoutError } from '@botforge/core'` — per-stage AbortController timeouts.
- `import { MockAdapter, fakeClock } from '@botforge/core/testing'` — for testing bot tools without a real Telegram + Anthropic.
- `ctx.skills.get('dlq')` — when the new dlq skill is enabled, bots can record failed work for later replay.

### Deploy notes

- `pnpm botforge deploy <bot>` correctly targets `/opt/botforge/bots/<bot>/` (was previously broken, see PR0).
- `pnpm botforge deploy <bot> --framework-version=<sha>` pins one bot's framework to a specific SHA via a systemd drop-in (T1.0).
- `pnpm botforge fleet-status` reports deployed-vs-branch SHA drift and canary state per bot.
- `pnpm botforge canary-gc` (default `--dry-run`, `--force` to delete) cleans up unreferenced `/opt/botforge-fw/<sha>/` dirs on the server.

---

## Pre-Tier-1 baseline

Anything before commit `04e08c8` (May 24 2026) is the "before" picture. The Tier-1 plan in `docs/framework-hardening-plan.md` exhaustively documents what changed and why.
