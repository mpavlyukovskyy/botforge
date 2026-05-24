# Framework Hardening — Week 0 Prereq Findings

## Prereq #1: Canary-pin deploy feasibility — CONFIRMED with scope clarification

**Current deployment model (verified from acemagic + source):**
- Shared framework at `/opt/botforge/packages/` (one copy across all 7 bots)
- Per-bot systemd unit runs `WorkingDirectory=/opt/botforge` + `ExecStart=/usr/bin/node packages/cli/dist/index.js dev bots/<name>.yaml`
- `build.ts` does `pnpm -r build` (compiles framework) + copies bot config/prompts/convention-dirs to `dist/<botName>/`
- `deploy.ts` ships `dist/<botName>/` to `/opt/botforge/<botName>/` via scp + atomic swap
- **Framework is NOT shipped per bot today** — bots resolve `@botforge/core` via the monorepo's `node_modules`

**For canary-pin to work, T1.0 must:**

1. **build.ts changes (~80 LOC)**: when `--framework-version=<sha>` flag passed:
   - `git checkout <sha>` in a worktree, then `pnpm -r build`
   - Copy `packages/*/dist/` and `packages/*/node_modules` into `dist/<botName>/.framework/`
   - Write `dist/<botName>/FRAMEWORK_SHA` text file with the SHA

2. **deploy.ts changes (~40 LOC)**: when bot has `.framework/`:
   - Generate per-bot systemd override at `/etc/systemd/system/botforge-<name>.service.d/framework.conf`:
     ```
     [Service]
     ExecStart=
     ExecStart=/usr/bin/node /opt/botforge/<name>/.framework/cli/dist/index.js dev /opt/botforge/<name>/config.yaml
     WorkingDirectory=/opt/botforge/<name>
     ```
   - `sudo systemctl daemon-reload` before restart
   - Health-check verifies the canary's `FRAMEWORK_SHA` matches deploy target

3. **New `fleet-status` CLI (~50 LOC)**: SSH each bot, read `/opt/botforge/<name>/FRAMEWORK_SHA`, print drift table

**Risks:**
- Per-bot systemd override needs `sudo` (already needed for restart; same auth path).
- 7× disk usage for framework (~10MB framework × 7 = ~70MB). Acceptable on acemagic.
- When all bots are on the same SHA (common case), the duplication is wasteful. Acceptable for personal scale.
- Rolling back: `rm /etc/systemd/system/botforge-<name>.service.d/framework.conf` + `daemon-reload` + restart returns the bot to the shared framework.

**Verdict**: feasible, ~170 LOC across build.ts + deploy.ts + new fleet-status command, no infra change beyond per-bot systemd override directories. Plan estimate (~150 LOC + 1 day) is close to right but slightly understated.

## Prereq #2: Budget cap measurement baseline

**Major surprise**: only 2 of 6 botforge bots have meaningful token-tracker data.

| Bot | Rows | Sample days | Lifetime spend | Observed max/day | Avg/day |
|---|---|---|---|---|---|
| Kristina | 15 | 15 | $2.99 (2 months) | $0.49 (2026-05-10) | $0.20 |
| Maia | 0 | 0 | $0.00 | — | — |
| Atlas | 0 | 0 | $0.00 | — | — |
| Harry | 0 | 0 | $0.00 | — | — |
| Trainer | 3 | 3 | $0.09 | $0.03 | $0.03 |
| ChiefOfStaff | 1 | 1 | $0.06 | $0.06 | $0.06 |

**4 of 6 bots have no token-tracker data.** Either the skill isn't wired into their YAMLs OR they're using an Anthropic SDK path that bypasses the framework wrapper. **This must be fixed before T1.5 can have meaningful per-bot caps.**

### Pre-T1.5 fix needed

Before T1.5 lands, add a small Tier 1 "T1.5-prereq" step:
- Audit each bot's YAML for token-tracker skill enablement (check `bots/*.yaml` for `skills.token-tracker: enabled`)
- Verify all Anthropic SDK calls go through the framework's tracking wrapper
- Estimate: 0.5 day audit + minor YAML/wiring fixes per bot

### Recommended caps (formula: max(p95×3, observed_max×1.5, $1 floor))

| Bot | Formula result | Recommended daily cap |
|---|---|---|
| Kristina | max(p95×3, $0.49×1.5, $1) = max(~$1.30, $0.74, $1) = **$1.30** | Round up to **$2/day** |
| Maia | no data → floor | **$5/day** (re-measure at 30 days) |
| Atlas | no data → floor | **$2/day** (multi-user but low-vol) |
| Harry | no data → floor | **$5/day** (LP outreach heavy potential) |
| Trainer | floor (very low) | **$1/day** |
| Chief-of-Staff | floor | **$3/day** (heavy email processing) |

**Total worst-case daily**: $18/day = $540/month. Workspace cap should be set ≥ $30/day = $900/mo to absorb spikes.

### `ANTHROPIC_WORKSPACE_CAP_USD` env var

For T2.8 to work, we need to know Mark's current workspace cap. **Action needed**: Mark to look up the cap in Anthropic console and provide the value. Default in plan: assume $30/day = $900/mo if unset.

## Prereq #3: Uptime Kuma on Fly.io

Confirmed user decision; requires `fly auth` from Mark's terminal. Deferred to user action.

## Stable-state for end of Week 0

- All findings documented (this file).
- Per-bot recommended budget caps computed.
- Ready to begin Tier 1 T1.0 implementation.
