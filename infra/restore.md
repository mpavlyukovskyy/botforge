# Restore-from-backup runbook

*T2.6 deliverable. Goes with the `@botforge/skill-backup` skill.*

Use this when:
- A bot's SQLite is corrupt and the bot won't start.
- An operator wants to roll the bot back to yesterday's state (e.g. accidental data deletion).
- The acemagic disk fails and bots need to be reconstituted on a fresh host.

## Backup target

Backups live on Mark's Mac at `~/botforge-backups/<botName>/YYYY-MM-DD/<bot>.db`.

The backup skill writes daily (cron'd at init + every 24h) via rsync over Tailscale. Local retention default 7 days; remote retention is whatever you've configured on the Mac side (Time Machine + the local pruning loop).

## Restore procedure (single bot)

```bash
# 1. SSH to acemagic
ssh acemagic

# 2. Stop the bot so it isn't writing while we restore.
sudo systemctl stop botforge-<bot>

# 3. Pick the backup date. List what's available:
ls ~/botforge-backups/<botName>/   # run from your Mac, or via Tailscale rsync ls

# 4. Pull the chosen day's DBs back to acemagic.
#    Replace <date> with e.g. 2026-05-24.
rsync -avz mark-mac.<tailscale>.ts.net:~/botforge-backups/<botName>/<date>/ \
   /tmp/restore-<bot>-<date>/

# 5. Backup what's currently on the bot, just in case.
sudo mv /opt/botforge/data/<botName>.db        /opt/botforge/data/<botName>.db.pre-restore
sudo mv /opt/botforge/data/<botName>-inbox.db  /opt/botforge/data/<botName>-inbox.db.pre-restore  || true
sudo mv /opt/botforge/data/<botName>-outbox.db /opt/botforge/data/<botName>-outbox.db.pre-restore || true
sudo mv /opt/botforge/data/<botName>-dlq.db    /opt/botforge/data/<botName>-dlq.db.pre-restore    || true

# 6. Move the restored DBs into place.
sudo cp /tmp/restore-<bot>-<date>/*.db /opt/botforge/data/
sudo chown -R m:m /opt/botforge/data/

# 7. Restart the bot.
sudo systemctl start botforge-<bot>

# 8. Verify health.
curl -s http://localhost:<port>/api/health | jq

# 9. Send a test message in the bot's Telegram chat. Confirm it responds.

# 10. After 24h of soak, delete the .pre-restore backups.
sudo rm /opt/botforge/data/<botName>.db.pre-restore /opt/botforge/data/<botName>-*.db.pre-restore
```

## Restore procedure (everything — host loss)

```bash
# 1. On a fresh acemagic-equivalent host: install pnpm, Node 22, sqlite3, rsync, systemd.

# 2. Clone /opt/botforge from the most recent rsync of the framework (kept as a Mac-side snapshot).

# 3. Restore all bot DBs:
for bot in trainer chief-of-staff kristina; do
  rsync -avz mark-mac.<tailscale>.ts.net:~/botforge-backups/$bot/<date>/ \
     /opt/botforge/data/
done

# 4. Install systemd units (committed at infra/systemd/ in this repo).

# 5. Start services + verify.
for svc in botforge-trainer botforge-chief-of-staff botforge-kristina; do
  sudo systemctl start $svc
  sleep 5
  systemctl is-active $svc
done
```

## Drill cadence

Per `docs/quarterly-review.md`: every 13 weeks, pick a random bot, run steps 1–8 against the previous week's backup into `/tmp/restore-drill/<bot>/`. Diff sqlite-rowcount against the live DB. Document any drift.

If a drill ever fails because the rsync target was offline > 36h or the sha256 mismatched, that's a serious finding — investigate the backup chain before the next quarterly review.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `rsync: connection unexpectedly closed` | Mac asleep, Tailscale down on Mac, or Mac firewall blocking SSH | Wake Mac; verify `ssh mark-mac.<tailscale>.ts.net` works first |
| Bot starts but conv-history is empty | Restored a DB that pre-dates the conversation_history table | Run the conv-history migration against the restored DB: `sqlite3 data/<bot>.db < packages/storage/sqlite/migrations/conv-history-v1.sql` |
| `database is locked` on first read | Bot wasn't fully stopped, or a stale WAL is present | `sudo systemctl stop botforge-<bot>`; delete `<bot>.db-wal` + `<bot>.db-shm`; restart |
| sha256 mismatch between source and restored target | Filesystem corruption, network bit-flip (rare) | Pull the prior day's backup and try again |
