# Session log — 2026-06-10

Everything done this session, with where it lives, how it was verified, and how to
operate/roll back. Three workstreams: (1) finished the Kristina incentive overhaul
(S8–S10, money model now LIVE), (2) cleanup/finalize pass (build fix, branch
hygiene, green CI), (3) built our own encrypted backups for the Atlas/finance DB
because Fly MPG backups are broken.

Cross-session recall: memory file `kristina-task-loss-poison-pill-2026-06-07.md`
(+ `MEMORY.md` index). Roadmap: `MASTER-BUILD-ROADMAP.md`. Cutover: `S10-CUTOVER-RUNBOOK.md`.

---

## 1. Incentive overhaul — S8, S9, S10 (INCENTIVE_V2 is now LIVE)

Whole money model was built flag-gated (default OFF == byte-identical to today),
phase by phase, then flipped on at S10. S1–S7 shipped before this session; S8–S10
this session.

### S8 — Milestones (finance-app + botforge)
- finance-app: `TaskItem.parentTaskId/isProject/valueShare`; migration
  `20260610230000_add_milestones` (applied to prod); items `route.ts` POST accepts
  parentTaskId/valueShare, PATCH passes isProject.
- botforge: `decompose` tool (owner-or-Mark) marks a task a project + creates
  milestone children. `markTaskDoneLocally`: a **project container earns 0**; a
  **milestone earns a PARTITION** of the parent's tiered value
  (`parentTierWeight × share/Σshares × decay`) — decomposing splits, never
  multiplies. board_state shows project rollup, excludes containers from Top-3.
- Tests: `milestone-partition.test.js` (3×-project split into 3 = 3 total not 9;
  unequal shares proportional; container = 0).

### S9 — Dashboard full surface (finance-app + botforge), flag-gated
- Server-side `getIncentiveV2Flag()` → `incentiveV2` prop into `TaskBoard`.
- When ON: positive **scoreboard** (pool/wins/on-time%/biggest win + live WIP
  gauge); **WIP limit (3) enforced on drag** before any optimistic move (visible
  rejection, not a silent catch); Mark-only **quality lever** in the task detail
  sheet — **Rework** (clears pay + bonus, moves to In Progress; bot reconcile
  resets the local `has_earned` latch so a redo re-earns) and **Mark excellent**
  (idempotent 1.15× bonus, rebases off the un-bonused value so it toggles).
- `qualityMult` Decimal column (migration `20260610234500_add_quality_mult`,
  default 1.0 = neutral); `reopenTask` / `markTaskExcellent` server actions
  (single-user app → `requireAuth` == Mark). Waiting (S6) + Project (S8) card badges.
- botforge earning multiplies by `quality_mult`; reconcile carries it + resets
  the earn-latch when Atlas reopens a task.
- Tests added to `mark-done-tier.test.js` (quality mult) + `sync.test.js`
  (reopen-latch reset, qualityMult round-trip). **140 bot tests green.**

### S10 — Cutover (LIVE 2026-06-10)
- Flipped `INCENTIVE_V2=true` in the prod Atlas `Config` table (verified via the
  bot config API = `{"INCENTIVE_V2":"true"}`; both dashboard + bot read this one
  source). Bot restarted clean (0 restarts, no errors), refreshes flag each reconcile.
- Pay-model guide (`S10-kristina-pay-guide.txt`) sent from the Kristina bot to the
  group chat (-5231435029, msg 7485).
- `IncentiveState` has zero readers → no seeding needed; flip is one row.

**Net effect for Kristina:** strictly more generous (no negative debt, blocked-time
pauses the clock) + stronger upside on high-priority work.

**ROLLBACK (instant):**
```sql
UPDATE "Config" SET value='false' WHERE key='INCENTIVE_V2';
```
Reverts within one reconcile. Frozen earnedValues from the ON window persist
(not recomputed either direction) — cleanest to flip at a month boundary if a
mixed month matters. Full runbook: `S10-CUTOVER-RUNBOOK.md`.

**Open (your decisions, not bugs):** the first real completion is the natural
end-to-end proof (can't be forced — needs a genuine Telegram "done"); this billing
month is mixed (old flat $1 before the flip, v2 after) — only matters if paying out
on the partial month.

---

## 2. Cleanup / finalize pass

### build.ts clean-dist fix (botforge, on main)
`packages/cli/src/commands/build.ts` now `rmSync(dist/<bot>)` before building.
Root cause: `cp -r src dist/<bot>/dir` copied INTO a never-cleaned dir, nesting
`lib/lib/` and leaving deleted files — which is why deploys needed a manual
`rm -rf dist/<bot>` first. **That workaround is no longer needed.** Verified by
planting a stale sentinel + nested `lib/lib` and confirming a clean build wipes both.

### Branch hygiene
- **finance-app**: local-only repo (no remote); fast-forwarded `master` to the S9 tip.
- **botforge**: long-lived `fix/kristina-atlas-truth-fundamental` → **PR #14 merged**
  to main (also applied the deliberate stale-fork removal — `standalone/taskbot` +
  `bots/alfred` were dead duplicates; live taskbot is its own repo at /opt/taskbot).

### Monorepo CI was RED on pre-existing debt — now GREEN
Discovered the whole botforge `pnpm -r run typecheck` CI gate had been failing on
**49 pre-existing TypeScript errors across 11 packages** (core, cli,
adapters/telegram, 8 skills, tools/tasks) — none from Kristina work; it blocked
every PR. Fixed all of them: test files got type-only fixes (non-null assertions,
`typeof` guards before `in`, `as unknown` cast, unused-import removal); 3 *source*
files got behavior-preserving fixes (polling-resilience.ts defaults backoff on an
empty schedule; canary-gc.ts guards `m?.[1]`; token-tracker gained
@types/better-sqlite3 + @types/node). **CI is now green** (PRs #14, #15 both green).

---

## 3. mp-finance-db backup system (NEW) — botforge PR #15 (merged)

**Why:** Fly Managed Postgres backups (full + incremental) FAIL for cluster
`d1zj5omg7q3oyqkv` (mp-finance-db, sjc) with no surfaced reason. No Fly ticket.
This DB holds the now-LIVE comp model + personal finance — losing it is unacceptable.

**How it was designed:** an agent-team workflow — 4 parallel env probes →
3 candidate architectures → adversarial critique → final recommendation. The
critique killed three false-safety assumptions (acemagic has no GPG private key;
the connection path was unproven; an on-box-only watchdog can't report its own death).

### What runs
acemagic owns it. Canonical source: botforge `infra/mp-finance-backup/`; deployed to
`/opt/mp-finance-db/` on acemagic.
- `backup.sh` — readonly Fly token → `flyctl agent`+`proxy 15432:5432
  pgbouncer.d1zj5omg7q3oyqkv.flympg.net -a mp-atlas` (the `.flympg.net` host is
  **6PN-only**) → `pg_dump -Fc` (BYTEA-safe) → **restore-verify the plaintext**
  into a throwaway scratch DB via `sudo -u postgres` on acemagic's native PG16
  `:5432` (asserts ≥39 tables, TaskAttachment BYTEA bytes>0, Transaction>1000,
  enums) → gpg-encrypt to `mp-finance-backup@local` → rclone to DO Spaces →
  rotate (local 7 / offsite daily 90d / monthly kept) → write PASS/FAIL state →
  push off-box Kuma heartbeat ONLY on full PASS.
- `mp-finance-backup.{service,timer}` — systemd, 2×/day (03:30 + 15:30 UTC,
  `Persistent=true`).

### Keys / secrets / storage
- GPG: **`mp-finance-backup@local`** (fp `B4A2EA88BE62DC5D6C74296B5CD197FC88D6F4F7`).
  **Private half is ONLY on the Mac** (passphraseless, FileVault-protected);
  acemagic has only the public key (so it can encrypt + verify-plaintext, never decrypt).
- `/opt/mp-finance-db/secrets.env` (0600, owner m): `FLY_API_TOKEN` (readonly,
  `-x 8760h` = 1y — **quoted**, it's `FlyV1 fm2_...` with a space), `DATABASE_URL`,
  `SPACES_KEY/SECRET/ENDPOINT` (reused from /opt/brain/secrets.env), `SPACES_BUCKET=mp-finance-db-backups`,
  `KUMA_PUSH_MPFINANCE`.
- Offsite: DO Spaces bucket **mp-finance-db-backups** (nyc3), `daily/` + `monthly/`.

### Liveness — two layers
1. **Off-box (primary dead-man's switch):** Uptime Kuma on Fly
   (`botforge-kuma.fly.dev`) monitor **id 9 `mp-finance-db-backup`** (push type,
   13h interval). backup.sh pushes `?status=up` only on a verified PASS, so a
   failed/empty/unrestorable backup OR a dead acemagic → no beat → Kuma alerts.
   (Kuma admin creds: `KUMA_ADMIN_USER/PASSWORD` in `~/.claude/secrets/api-keys.env`.)
2. **On-box (secondary, detailed):** `/opt/health-probes/fleet-watchdog.sh`
   (cron, every 5 min) reads `/opt/health-probes/state/mp-finance-last-verify.txt`
   PASS/FAIL ground-truth and DMs Telegram 381823289 (hourly dedup + recovery).

### Verified (not claimed)
- Backup PASS: `39 tables / 6170 txn / 77 attach / 1,055,547 BYTEA bytes`, encrypted
  artifact (~1.96MB) offsite. State file shows PASS.
- Kuma push returns `{"ok":true}`, monitor active.
- **Disaster-recovery drill PASSED**: pulled the *real* offsite `.gpg`, decrypted
  with the Mac-only key, validated a 39-table restorable archive.
- Timer enabled (next run 03:30 UTC); watchdog silent on healthy.

### How to operate
```bash
# Run a backup now:
ssh acemagic 'bash /opt/mp-finance-db/backup.sh'
# Check last verify:
ssh acemagic 'cat /opt/health-probes/state/mp-finance-last-verify.txt'
# List offsite backups:
ssh acemagic 'set -a; source /opt/mp-finance-db/secrets.env; set +a; \
  export RCLONE_CONFIG_SP_TYPE=s3 RCLONE_CONFIG_SP_PROVIDER=DigitalOcean \
   RCLONE_CONFIG_SP_ACCESS_KEY_ID="$SPACES_KEY" RCLONE_CONFIG_SP_SECRET_ACCESS_KEY="$SPACES_SECRET" \
   RCLONE_CONFIG_SP_ENDPOINT="$SPACES_ENDPOINT"; rclone lsl "sp:$SPACES_BUCKET/daily/"'
```
Full recovery + token/password rotation: `infra/mp-finance-backup/RESTORE.md`.

### Gotchas hit + fixed (so we don't relearn them)
- Fly token is `FlyV1 fm2_...` — **has a space**, must be quoted in env files or
  `source` tries to execute the second half.
- `set -euo pipefail` bit twice: (a) a `grep | grep` that filters to empty exits 1;
  (b) `gpg --list-packets | grep -q` SIGPIPEs gpg → both need `|| true` / here-string.
- `gpg --list-packets` exits non-zero without the secret key (it can't decrypt the
  session key) — check its OUTPUT for the packet, not the exit code.
- `sudo -u postgres pg_restore` needs the backups dir **setgid postgres** + parent
  dir group-traversable + the dump chmod 640 to read it.
- Restore into vanilla PG16 throws 4 benign errors (Fly/Percona `pg_stat_monitor`
  + `pgaudit` extensions absent) — tolerate ONLY those; the data assertions are the gate.
- Kuma push monitors via socket.io v4 API: omit `conditions`/`tags` from the add
  payload (not real columns), and supply your OWN `pushToken` (this version doesn't
  auto-generate one).

### Standing risk (single-runner — acknowledged, mitigated)
acemagic is the only runner. If it dies the on-box watchdog dies too — but the
off-box Kuma push stops → Kuma alerts (and brain's existing Kuma heartbeat also
flags acemagic being down). No Fly ticket required; no open infra flags on this work.

---

## State of the world at end of session
- INCENTIVE_V2: **ON** (live comp model). Rollback = one Config UPDATE.
- botforge: `main`, clean, **CI green**. PRs #14 + #15 merged.
- finance-app: `master`, clean (local-only repo).
- mp-finance-db backups: live, 2×/day, verified, offsite, dual liveness, DR-drilled.
- Bot (kristina) healthy on acemagic; Atlas (mp-atlas) healthy on Fly.
