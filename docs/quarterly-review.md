# Botforge Quarterly Review Checklist

*Run every 13 weeks. Drift in any of these areas is what bites — operator vigilance is the only defense.*

## Cost + capacity

- [ ] **Anthropic workspace cap**: verify `ANTHROPIC_WORKSPACE_CAP_USD` env on each bot matches the actual cap shown in Anthropic's console. The May 18 2026 Kristina outage was a workspace cap hit that surfaced as silent "Sorry, I couldn't process that" messages for 9 days.
- [ ] **Per-bot budget caps**: pull last 30 days of `token_usage` per bot. Recompute `max(p95 × 3, observed_max × 1.5, $1 floor)`. Update `brain.budget_usd_per_day` in each bot YAML if reality has moved.
- [ ] **Claude model versions**: confirm bots are on the most current cost-effective model. Pricing changes silently. Re-baseline budget caps if a model swap happened.

## Backups + recovery

- [ ] **Restore drill**: pick one random bot, restore last week's backup to `/tmp/restore-drill/`, sqlite-rowcount-diff against current. Document any drift.
- [ ] **Last successful backup ts**: every bot's `last_successful_backup_ts` < 36h ago. If not, investigate why before the next quarterly review (don't wait).
- [ ] **Mac availability for rsync target**: confirm Mark's Mac was reachable via Tailscale ≥99% of the last quarter. If not, evaluate alternate backup target.

## Secrets

- [ ] **Inventory**: every `grep -r ANTHROPIC_\|TELEGRAM_\|API_KEY` hit has a documented entry in `infra/secrets.md` with rotation cadence and owner.
- [ ] **Rotation**: Telegram bot tokens, Anthropic API key, Postmark token, Uptime Kuma push tokens. Anything that's been in place > 12 months gets rotated.

## Drift

- [ ] **`botforge fleet-status`**: drift column == 0 distinct SHAs across the fleet, OR drift is intentional (active canary). If a canary has been pinned >30 days, ask why.
- [ ] **Bot dist drift**: for each bot, `find bots/<bot> -type f | sort` matches `ssh acemagic find /opt/botforge/bots/<bot>...`. Mark's manual SCPs (per `~/.claude/CLAUDE.md`) shouldn't accumulate unmerged on the server forever.
- [ ] **Cron `replay_on_crash` audit**: every cron handler still matches its declared `replay_on_crash`. Handlers that became non-idempotent need to flip to `false`; new idempotent handlers can opt in.

## Infrastructure

- [ ] **Uptime Kuma monitors**: monitor count matches the bot count + per-bot critical crons. Stale monitors for retired bots are removed.
- [ ] **DNS caching on acemagic**: `dnsmasq` is running and the upstream chain (`1.1.1.1`, `8.8.8.8`, `9.9.9.9`) is alive.
- [ ] **systemd unit files in repo match deployed**: `diff infra/systemd/botforge-*.service` against `ssh acemagic 'sudo cat /etc/systemd/system/botforge-*.service'`. Any diffs are intentional, reviewed.

## Code health

- [ ] **`pnpm audit` clean**: no high/critical CVEs. Dependabot PRs (T3.10) merged.
- [ ] **Anthropic + Telegram SDK pins**: at most 1 minor version behind latest. A major version bump is a feature flag + soak, not a quarterly auto-update.
- [ ] **`runtime.ts` LOC**: still under 700. If it has grown back past 700, refactor before another concern accumulates.
- [ ] **`as any` casts in runtime + brain-processor**: count via `grep -c "as any"`. Target: monotonically decreasing.

## Incidents this quarter

- [ ] **List**: every user-visible incident (bot down, message lost, wrong reply) recorded with root cause + the test that would have caught it.
- [ ] **Test debt**: any incident whose test wasn't written yet — write it before the next quarterly review.

---

*Last reviewed: TBD. Next due: TBD + 90 days.*
