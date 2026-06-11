#!/usr/bin/env bash
# mp-finance-db (Atlas) encrypted backup — runs on acemagic (the always-on box).
#
# Fly Managed Postgres backups are broken for this cluster and Mark won't file a
# Fly ticket, so we own backups. This DB holds the LIVE Kristina compensation
# model + personal financial data — losing it is unacceptable.
#
# Flow (defense-in-depth; every claim below was verified before shipping):
#   1. flyctl agent + proxy to the pgBouncer endpoint (the .flympg.net host is
#      6PN/WireGuard-only; a readonly org token is enough to bring the tunnel up).
#   2. pg_dump -Fc (binary-safe: captures TaskAttachment.imageData BYTEA, jsonb,
#      enums, _prisma_migrations, all tables) to a local plaintext archive.
#   3. RESTORE-VERIFY the PLAINTEXT into a throwaway scratch DB on acemagic's
#      native PG16 (:5432) and assert real ground truth (table count, BYTEA bytes,
#      Transaction rows). acemagic has NO gpg private key, so verifying the
#      plaintext BEFORE encryption is the only key-free restore proof on-box.
#   4. gpg-encrypt to mp-finance-backup@local (private half lives ONLY on the Mac)
#      and integrity-gate the artifact, then delete the plaintext.
#   5. rclone push to an isolated DO Spaces bucket; rotate local + offsite.
#   6. Write a PASS/FAIL ground-truth state file and, ONLY on full PASS, push an
#      off-box Uptime-Kuma heartbeat (the real dead-man's switch that survives
#      acemagic dying). On any failure: no push -> Kuma alerts; state=FAIL ->
#      fleet-watchdog DMs Mark's Telegram.
#
# Source of truth: botforge repo infra/mp-finance-backup/backup.sh.
set -euo pipefail

SECRETS=/opt/mp-finance-db/secrets.env
BDIR=/opt/mp-finance-db/backups
STATE_DIR=/opt/health-probes/state
STATE_FILE="$STATE_DIR/mp-finance-last-verify.txt"
PORT=15432                      # local proxy port
SIZE_FLOOR=200000               # bytes; a smaller .gpg is suspect (DB is ~2MB compressed)
EXPECT_MIN_TABLES=39            # public-schema tables at ship time; grows with migrations
SCRATCH="mpf_verify_$$_$(date -u +%s)"
PROXY_PID=""
PLAINTEXT=""

mkdir -p "$BDIR" "$STATE_DIR"

fail() {
  local reason="$1"
  echo "FAIL $(date -u +%Y-%m-%dT%H:%M:%SZ) $reason" > "$STATE_FILE"
  echo "mp-finance backup FAILED: $reason" >&2
  exit 1   # no Kuma push -> off-box missing-heartbeat alert fires
}

cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  sudo -u postgres dropdb -p 5432 --if-exists "$SCRATCH" 2>/dev/null || true
  [ -n "$PLAINTEXT" ] && rm -f "$PLAINTEXT" 2>/dev/null || true
}
trap cleanup EXIT

set -a; source "$SECRETS"; set +a
: "${FLY_API_TOKEN:?missing in secrets.env}" "${DATABASE_URL:?}" "${SPACES_KEY:?}" \
  "${SPACES_SECRET:?}" "${SPACES_ENDPOINT:?}" "${SPACES_BUCKET:?}"

# Disk-pressure guard (scratch restore + retention must not be what fills /).
USEPCT=$(df / | awk 'NR==2{print $5+0}')
[ "$USEPCT" -ge 90 ] && fail "disk / at ${USEPCT}% (>=90), refusing to run"

# 1. Tunnel up (readonly token; agent must be warm before proxy resolves 6PN DNS).
export FLY_API_TOKEN
~/.fly/bin/flyctl agent start >/dev/null 2>&1 || true
sleep 4
pkill -f "flyctl proxy ${PORT}:" 2>/dev/null || true
~/.fly/bin/flyctl proxy "${PORT}:5432" pgbouncer.d1zj5omg7q3oyqkv.flympg.net -a mp-atlas >/tmp/mpf-proxy.log 2>&1 &
PROXY_PID=$!
for i in $(seq 1 30); do nc -z 127.0.0.1 "$PORT" 2>/dev/null && break; sleep 1; done
nc -z 127.0.0.1 "$PORT" 2>/dev/null || fail "proxy did not open on :$PORT ($(tail -2 /tmp/mpf-proxy.log 2>/dev/null | tr '\n' ' '))"

# 2. Dump (rewrite the URL host -> local proxy; force sslmode=require).
URL=$(printf '%s' "$DATABASE_URL" | sed -E "s#@[^/]+/#@127.0.0.1:${PORT}/#")
case "$URL" in *\?*) URL="$URL&sslmode=require";; *) URL="$URL?sslmode=require";; esac
TS=$(date -u +%Y%m%dT%H%M%SZ)
PLAINTEXT="$BDIR/mp-finance-$TS.dump"
pg_dump "$URL" -Fc --no-owner --no-privileges --no-acl --no-sync -f "$PLAINTEXT" 2>/tmp/mpf-dump.log \
  || fail "pg_dump failed: $(tail -2 /tmp/mpf-dump.log | tr '\n' ' ')"
[ -s "$PLAINTEXT" ] || fail "pg_dump produced empty file"
# The restore-verify runs as the 'postgres' OS user (only role that can createdb
# locally). The backups dir is setgid 'postgres'; make this plaintext group-
# readable so pg_restore can open it. It is deleted right after encryption.
chmod 640 "$PLAINTEXT" 2>/dev/null || true

# 3. Restore-verify the plaintext into a scratch DB (key-free proof on acemagic).
sudo -u postgres createdb -p 5432 "$SCRATCH" || fail "createdb scratch failed"
# pg_restore exits non-zero for benign, environment-specific errors: the Fly/Percona
# source has monitoring extensions (pg_stat_monitor, pgaudit) that vanilla PG16 lacks,
# so CREATE EXTENSION/COMMENT on them fail harmlessly (data is unaffected). Tolerate
# ONLY those; any other error is fatal. The data assertions below are the real gate.
sudo -u postgres pg_restore -p 5432 --no-owner --no-privileges -d "$SCRATCH" "$PLAINTEXT" 2>/tmp/mpf-restore.log || true
# NB: the grep pipeline legitimately exits 1 when it filters everything out (the
# common success case — only benign extension errors). `|| true` keeps that from
# tripping `set -e`/`pipefail`.
UNEXPECTED=$(grep -i "error:" /tmp/mpf-restore.log | grep -viE "pg_stat_monitor|pgaudit" | head -3 || true)
[ -n "$UNEXPECTED" ] && fail "unexpected pg_restore errors: $(echo "$UNEXPECTED" | tr '\n' '|')"
q() { sudo -u postgres psql -p 5432 -d "$SCRATCH" -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
TABLES=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
ATT_ROWS=$(q "SELECT count(*) FROM \"TaskAttachment\"")
ATT_BYTES=$(q "SELECT COALESCE(sum(octet_length(\"imageData\")),0) FROM \"TaskAttachment\"")
TXN=$(q "SELECT count(*) FROM \"Transaction\"")
ENUMS=$(q "SELECT count(*) FROM pg_type WHERE typtype='e'")
[ "${TABLES:-0}" -ge "$EXPECT_MIN_TABLES" ] || fail "restored table count ${TABLES:-?} < $EXPECT_MIN_TABLES (partial dump)"
[ "${ATT_BYTES:-0}" -gt 0 ] || fail "TaskAttachment BYTEA bytes=0 (binary data did not round-trip)"
[ "${TXN:-0}" -gt 1000 ] || fail "Transaction rows ${TXN:-?} <=1000 (suspiciously empty)"
[ "${ENUMS:-0}" -gt 0 ] || fail "no enum types restored"
sudo -u postgres dropdb -p 5432 --if-exists "$SCRATCH" || true

# 4. Encrypt (acemagic has only the public key) + integrity-gate, then drop plaintext.
gpg --batch --yes --trust-model always -r mp-finance-backup@local -o "$PLAINTEXT.gpg" --encrypt "$PLAINTEXT" \
  || fail "gpg encrypt failed"
# Validate the artifact's STRUCTURE without the private key: --list-packets exits
# non-zero here (it can't decrypt the session key — acemagic has no secret key by
# design), so grep its output for the pubkey-encryption packet instead of trusting
# the exit code. True decryptability is proven by the E2E Mac drill.
PKTS=$(gpg --list-packets "$PLAINTEXT.gpg" 2>/dev/null || true)
grep -qiE "pubkey enc|encrypted data" <<<"$PKTS" \
  || fail "gpg artifact has no encryption packet (malformed)"
GPG_SIZE=$(stat -c%s "$PLAINTEXT.gpg")
[ "$GPG_SIZE" -ge "$SIZE_FLOOR" ] || fail "encrypted artifact ${GPG_SIZE}B < floor ${SIZE_FLOOR}B"
# size sanity vs prior good run (catch a sudden collapse)
PRIOR=$(awk '/^PASS/{print $NF}' "$STATE_FILE" 2>/dev/null | sed 's/size=//' | tail -1 || true)
if [ -n "${PRIOR:-}" ] && [ "$PRIOR" -gt 0 ] 2>/dev/null; then
  HALF=$(( PRIOR / 2 ))
  [ "$GPG_SIZE" -ge "$HALF" ] || fail "artifact ${GPG_SIZE}B < 50% of prior ${PRIOR}B"
fi
rm -f "$PLAINTEXT"; PLAINTEXT=""

# 5. Offsite push (isolated bucket) + rotation (local 7, offsite 90d, monthly kept).
export RCLONE_CONFIG_SP_TYPE=s3 RCLONE_CONFIG_SP_PROVIDER=DigitalOcean
export RCLONE_CONFIG_SP_ACCESS_KEY_ID="$SPACES_KEY" RCLONE_CONFIG_SP_SECRET_ACCESS_KEY="$SPACES_SECRET"
export RCLONE_CONFIG_SP_ENDPOINT="$SPACES_ENDPOINT"
rclone copy "$BDIR/mp-finance-$TS.dump.gpg" "sp:$SPACES_BUCKET/daily/" || fail "rclone push to daily/ failed"
if [ "$(date -u +%d)" = "01" ]; then
  rclone copy "$BDIR/mp-finance-$TS.dump.gpg" "sp:$SPACES_BUCKET/monthly/" || true
fi
ls -1t "$BDIR"/mp-finance-*.dump.gpg | tail -n +8 | xargs -r rm -f
rclone delete --min-age 90d "sp:$SPACES_BUCKET/daily/" 2>/dev/null || true

# 6. Ground-truth state + off-box heartbeat (only on full PASS).
echo "PASS $(date -u +%Y-%m-%dT%H:%M:%SZ) tables=$TABLES txn=$TXN attach_rows=$ATT_ROWS attach_bytes=$ATT_BYTES size=$GPG_SIZE" > "$STATE_FILE"
if [ -n "${KUMA_PUSH_MPFINANCE:-}" ]; then
  curl -sf -m 10 "${KUMA_PUSH_MPFINANCE}?status=up&msg=ok" >/dev/null 2>&1 || true
fi
echo "mp-finance backup ok: mp-finance-$TS.dump.gpg (${GPG_SIZE}B) verified+offsite (tables=$TABLES txn=$TXN attach_bytes=$ATT_BYTES)"
