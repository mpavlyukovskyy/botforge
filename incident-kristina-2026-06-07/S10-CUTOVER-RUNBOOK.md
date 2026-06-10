# S10 — Cutover Runbook (INCENTIVE_V2 flip)

Status: **PREPARED, NOT EXECUTED.** The whole money model is built and verified
dark on prod (S1–S9 shipped; Config table empty → flag OFF → byte-identical to
today). This is the single, deliberate step that makes the new comp model LIVE
for Kristina. It needs Mark's explicit go because it changes a real person's pay
calculation and (per plan) is announced to her.

## What flipping ON actually changes for Kristina's pay

| Lever | OFF (today) | ON (after flip) |
|-------|-------------|-----------------|
| Floor | overdue tasks can go **negative** (debt) | floored at **$0** — she can never go below zero on a task |
| Priority | no effect on pay | ROUTINE ×0.5, STANDARD ×1, IMPORTANT ×3, P0 ×8 |
| Late | linear decay incl. negative | decays toward $0, never past it |
| Blocked | counts against her | clock **pauses** while waiting on a third party |
| Projects | n/a | milestones **split** a project's value (never multiply) |
| Quality | n/a | Mark can mark work "excellent" → 1.15× bonus; "rework" clears + lets a redo re-earn |

Net effect is **strictly more generous and less punitive** (no debt, blocked
pauses) plus stronger upside on high-priority work. The only downside cases vs
today: ROUTINE tasks pay 0.5× and a still-late task earns less than today's
(possibly negative) number — but never negative.

## The flip (one row in the Config table — both surfaces read it)

`Config` is `{ key @id, value, updatedAt }` — `key` is the primary key, no `id`
column. `IncentiveState` has no readers, so no seeding is required before flip.

```bash
cd /Users/Mark/Documents/dev/finance-app
printf "INSERT INTO \"Config\" (key, value, \"updatedAt\") VALUES ('INCENTIVE_V2', 'true', now()) ON CONFLICT (key) DO UPDATE SET value='true', \"updatedAt\"=now();\n" > /tmp/flip_on.sql
~/.fly/bin/flyctl ssh console -a mp-atlas -C "node_modules/.bin/prisma db execute --stdin" < /tmp/flip_on.sql
```

## Verify ON (both surfaces)

```bash
# Bot's source of truth:
ssh acemagic 'curl -s -H "Authorization: Bearer $(grep -i ATLAS_SYNC_KEY /opt/botforge/.env* | head -1 | cut -d= -f2 | tr -d \")" https://mp-atlas.fly.dev/api/sync/kristina-bot/config'
# expect: {"config":{"INCENTIVE_V2":"true"}}
```
Then on the dashboard `/finance/tasks`: scoreboard + WIP gauge appear; complete a
test task → earned value reflects tier × decay (× quality); reopen clears it.
Bot picks up the flag on its next reconcile (≤5 min) or restart.

## Rollback (instant, safe)

```bash
printf "UPDATE \"Config\" SET value='false', \"updatedAt\"=now() WHERE key='INCENTIVE_V2';\n" > /tmp/flip_off.sql
~/.fly/bin/flyctl ssh console -a mp-atlas -C "node_modules/.bin/prisma db execute --stdin" < /tmp/flip_off.sql
```
Flag OFF → behavior reverts to today within one reconcile. No data migration to
undo (earnedValues already frozen stay; future completions use the OFF path).
Frozen earnedValues from the ON window persist — they are not retroactively
recomputed either direction. Decide whether that's acceptable for the billing
month before flipping mid-month (cleaner to flip at a month boundary).

## Liveness (the shipping rule)

Existing kristina deep probe `/opt/health-probes/kristina-probe.sh` + fleet
watchdog cover the bot process. The flag flip itself has no new failure mode
(missing/false key = OFF = safe default). After flip, watch one real completion
land with the expected earned value as the end-to-end proof.

## Remaining S10 step

Send Kristina the pay-model message (`S10-kristina-pay-guide.txt`) — this is the
ONE point pay is explained to her. Recommend sending it at/just-before the flip
so the change and the explanation arrive together.
