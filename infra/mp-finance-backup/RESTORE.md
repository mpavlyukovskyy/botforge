# Restore mp-finance-db (Atlas / Fly MPG) from an encrypted backup

The prod Postgres for **mp-atlas** (Kristina compensation model + personal
finance) is backed up by `/opt/mp-finance-db/backup.sh` on **acemagic** because
Fly MPG's own backups fail for cluster `d1zj5omg7q3oyqkv` (mp-finance-db, sjc).

Backups are `pg_dump -Fc` (custom format), gpg-encrypted to **mp-finance-backup@local**
(private key **only on Mark's Mac**), in DO Spaces bucket **mp-finance-db-backups**
(`daily/` kept 90d, `monthly/` kept forever) and locally in `/opt/mp-finance-db/backups`
(last 7). Every run restore-verifies the *plaintext* on acemagic before encrypting.

## A. Inspect / fetch a backup

```bash
# Latest offsite (run on acemagic where the Spaces creds live):
ssh acemagic
set -a; source /opt/mp-finance-db/secrets.env; set +a
export RCLONE_CONFIG_SP_TYPE=s3 RCLONE_CONFIG_SP_PROVIDER=DigitalOcean \
  RCLONE_CONFIG_SP_ACCESS_KEY_ID="$SPACES_KEY" RCLONE_CONFIG_SP_SECRET_ACCESS_KEY="$SPACES_SECRET" \
  RCLONE_CONFIG_SP_ENDPOINT="$SPACES_ENDPOINT"
rclone lsl "sp:$SPACES_BUCKET/daily/" | sort | tail -5      # newest at bottom
```

## B. Full recovery (decrypt + restore) — runs on the MAC (only host with the private key)

The Mac needs Postgres client tools (not installed by default):
```bash
brew install libpq && echo 'export PATH=/opt/homebrew/opt/libpq/bin:$PATH' >> ~/.zprofile && exec $SHELL -l
```

```bash
# 1. Pull the chosen artifact from Spaces to the Mac (via acemagic, which has creds):
ssh acemagic 'set -a; source /opt/mp-finance-db/secrets.env; set +a; \
  export RCLONE_CONFIG_SP_TYPE=s3 RCLONE_CONFIG_SP_PROVIDER=DigitalOcean \
   RCLONE_CONFIG_SP_ACCESS_KEY_ID="$SPACES_KEY" RCLONE_CONFIG_SP_SECRET_ACCESS_KEY="$SPACES_SECRET" \
   RCLONE_CONFIG_SP_ENDPOINT="$SPACES_ENDPOINT"; \
  rclone copy "sp:$SPACES_BUCKET/daily/<FILE>.dump.gpg" /tmp/'
scp acemagic:/tmp/<FILE>.dump.gpg /tmp/

# 2. Decrypt with the Mac-only private key:
gpg --output /tmp/mp-finance.dump --decrypt /tmp/<FILE>.dump.gpg

# 3. Restore into a FRESH, EMPTY Postgres 16 (do NOT run prisma migrate first —
#    the dump already contains the schema + _prisma_migrations; migrating first
#    causes "relation already exists"):
createdb mp_finance_restore
pg_restore --no-owner --no-privileges -d mp_finance_restore /tmp/mp-finance.dump

# 4. Sanity-check the restore reproduced real data incl. binary image bytes:
psql -d mp_finance_restore -c \
  'SELECT count(*) AS attach_rows, sum(octet_length("imageData")) AS attach_bytes FROM "TaskAttachment";'   # expect ~77 rows / ~1,055,547 bytes
psql -d mp_finance_restore -c 'SELECT count(*) FROM "Transaction";'                                          # expect ~6000+
```

## C. Push a recovered DB back to prod (disaster recovery)

If the live cluster is lost, restore the dump into a new Fly MPG cluster (or any
PG16), then point mp-atlas's `DATABASE_URL` secret at it:
`flyctl secrets set DATABASE_URL='postgres://...' -a mp-atlas`.

## Gotchas
- **Password rotation:** if the `fly-user` password rotates, `backup.sh` fails
  (caught within ~12h by Kuma + Telegram). Re-fetch and update secrets.env:
  `flyctl ssh console -a mp-atlas -C "printenv DATABASE_URL"` →
  `DATABASE_URL=` line in `/opt/mp-finance-db/secrets.env`.
- **Connection path:** the DB host `pgbouncer.d1zj5omg7q3oyqkv.flympg.net` is
  6PN-only; backups reach it via `flyctl proxy` on acemagic using the readonly
  Fly token in secrets.env. If the token expires (`-x 720h` = 30d), re-mint:
  `flyctl tokens create readonly -x 720h personal` → update `FLY_API_TOKEN`.
- **Verify state:** `/opt/health-probes/state/mp-finance-last-verify.txt` holds
  the last PASS/FAIL + row/byte counts; fleet-watchdog reads it.
