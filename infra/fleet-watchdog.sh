#!/bin/bash
# Fleet liveness watchdog — the dead-observer fix for the botforge fleet.
#
# A bot process being "active" is not the same as it doing its job, and a
# dead bot cannot report its own death. This watchdog runs OUTSIDE every bot
# process (cron, /etc/cron.d/bot-health) and checks each service two ways:
# systemd active + local health endpoint. Alerts Mark's Telegram DM with
# hourly dedup per bot and a recovery message when a bot comes back.
#
# Replaces /opt/scripts/health-check.sh (stale bot list: agenda-bot, lp-bot,
# nzpe-agent etc. are defunct; no dedup; token read from /opt/kristina-bot).
#
# kristina is EXCLUDED here: /etc/cron.d/kristina-probe runs the richer
# /opt/health-probes/kristina-probe.sh (deep /api/probe + Atlas alerting).
# One owner per bot — don't double-alert.
#
# Source of truth: botforge repo infra/fleet-watchdog.sh. Deploy:
#   scp infra/fleet-watchdog.sh acemagic:/tmp/ && ssh acemagic \
#     "sudo cp /tmp/fleet-watchdog.sh /opt/health-probes/ && sudo chmod +x /opt/health-probes/fleet-watchdog.sh"
#
# Ownership split (one owner per concern — kristina precedent):
#   fleet-watchdog  = service-up checks + Whoop data freshness (below)
#   Uptime Kuma     = process heartbeat push
#   kristina-probe  = kristina only (excluded here)
#
# Usage: fleet-watchdog.sh [--selftest]
#   --selftest  send a test DM to verify the alert channel, then exit
#
# Kill-test overrides (exercise the deployed artifact without touching prod):
#   WHOOP_DB_OVERRIDE=/tmp/copy.db WHOOP_STALE_HOURS_OVERRIDE=0 ./fleet-watchdog.sh
#   TG_DRYRUN=1 prints alerts to stdout instead of sending.

set -u

ENV_FILE="/opt/botforge/.env"
STATE_DIR="/opt/health-probes/state"
ALERT_CHAT="381823289" # Mark's DM

BOT_TOKEN=""
if [ -f "$ENV_FILE" ]; then
  BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi
if [ -z "$BOT_TOKEN" ]; then
  echo "fleet-watchdog: no TELEGRAM_BOT_TOKEN in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
NOW_UTC=$(date -u +'%Y-%m-%d %H:%M UTC')
HOUR_KEY=$(date -u +'%Y-%m-%d-%H')

# name:systemd_unit:port:health_path  (kristina intentionally absent — see header)
FLEET=(
  "hali99:botforge-hali99:8089:/api/health"
  "chief-of-staff:botforge-chief-of-staff:8091:/api/health"
  "trainer:botforge-trainer:8092:/api/health"
  "taskbot:taskbot:8088:/api/health"
  "babushka:babushka-stories:8085:/health"
)

send_tg() {
  if [ "${TG_DRYRUN:-0}" = "1" ]; then
    echo "TG_DRYRUN: $1"
    return 0
  fi
  curl -sS --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${ALERT_CHAT}" \
    --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--selftest" ]; then
  send_tg "🔧 fleet-watchdog selftest OK @ ${NOW_UTC} (monitoring: hali99, chief-of-staff, trainer, taskbot, babushka)"
  echo "selftest sent"
  exit 0
fi

for entry in "${FLEET[@]}"; do
  IFS=: read -r NAME SVC PORT HPATH <<< "$entry"
  STATE_FILE="${STATE_DIR}/${NAME}-fleet-alert.txt"
  REASON=""

  if ! systemctl is-active --quiet "$SVC" 2>/dev/null; then
    REASON="systemd:$(systemctl is-active "$SVC" 2>/dev/null || echo unknown)"
  else
    HTTP=$(curl -sf --max-time 10 -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:${PORT}${HPATH}" 2>/dev/null || echo "000")
    [ "$HTTP" != "200" ] && REASON="health:HTTP_${HTTP}"
  fi

  if [ -z "$REASON" ]; then
    # Healthy: close out any open alert episode with a recovery note.
    if [ -f "$STATE_FILE" ]; then
      LAST=$(cat "$STATE_FILE" 2>/dev/null || echo "")
      [ -n "$LAST" ] && send_tg "✅ ${NAME} recovered on acemagic @ ${NOW_UTC} (was failing since ${LAST})."
      rm -f "$STATE_FILE"
    fi
  else
    # Failing: alert at most once per UTC hour per bot (cron runs every 5 min).
    LAST=$(cat "$STATE_FILE" 2>/dev/null || echo "")
    if [ "$LAST" != "$HOUR_KEY" ]; then
      echo "$HOUR_KEY" > "$STATE_FILE"
      send_tg "🚨 ${NAME} DOWN on acemagic @ ${NOW_UTC} — ${REASON}. Check: journalctl -u ${SVC} -n 50"
      echo "alerted: ${NAME} ${REASON}"
    fi
  fi
done

# --- trainer Whoop data freshness (shipping-rule outside-the-bot check) -----
# Two conditions against the LIVE bot DB (read-only — never takes write locks):
#  (a) bot-wedged: token marked dead >1h ago but the bot never managed to send
#      its own death alert (alert key absent from bot_state). The bot's
#      observation-based alerting normally covers death within 5 min; this
#      fires only when the bot itself is broken.
#  (b) staleness: no Whoop recovery score in WHOOP_STALE_HOURS (72h default —
#      tolerates strap-off weekends), suppressed while any whoop_* alert key
#      is set (the bot is already alerting; one nag per condition).
# dead_at and alert-state timestamps are JS epoch SECONDS (pinned by
# bots/trainer/tests/probe-sql.test.js against this same SQL).
WHOOP_DB="${WHOOP_DB_OVERRIDE:-/opt/botforge/data/Trainer-trainer.db}"
WHOOP_STALE_HOURS="${WHOOP_STALE_HOURS_OVERRIDE:-72}"
WHOOP_ALERT_STATE="${STATE_DIR}/trainer-whoop-freshness-alert.txt"

check_whoop_freshness() {
  [ -f "$WHOOP_DB" ] || { echo "whoop-freshness: DB not found at $WHOOP_DB" >&2; return; }
  command -v sqlite3 >/dev/null || return

  local now reason="" dead_row dead_at status alert_key_count
  now=$(date -u +%s)

  dead_row=$(sqlite3 -readonly "$WHOOP_DB" \
    "SELECT status || '|' || COALESCE(dead_at,0) FROM oauth_tokens WHERE provider='whoop'" 2>/dev/null || echo "")
  status="${dead_row%%|*}"
  dead_at="${dead_row##*|}"

  alert_key_count=$(sqlite3 -readonly "$WHOOP_DB" \
    "SELECT COUNT(*) FROM bot_state WHERE key LIKE 'whoop_%' AND value != ''" 2>/dev/null || echo "0")

  if [ "$status" = "dead" ] && [ "${dead_at:-0}" -gt 0 ] && [ $(( now - dead_at )) -gt 3600 ]; then
    local dead_key_present
    dead_key_present=$(sqlite3 -readonly "$WHOOP_DB" \
      "SELECT COUNT(*) FROM bot_state WHERE key='whoop_token_dead' AND value != ''" 2>/dev/null || echo "0")
    if [ "$dead_key_present" = "0" ]; then
      reason="trainer marked Whoop token DEAD $(( (now - dead_at) / 3600 ))h ago but never alerted (bot wedged?)"
    fi
  fi

  if [ -z "$reason" ] && [ "$alert_key_count" = "0" ]; then
    local last_score_age_h
    last_score_age_h=$(sqlite3 -readonly "$WHOOP_DB" "
      SELECT CAST(($now - strftime('%s', MAX(date) || 'T12:00:00Z')) / 3600 AS INTEGER)
      FROM recovery_daily WHERE whoop_recovery_score IS NOT NULL" 2>/dev/null || echo "")
    if [ -n "$last_score_age_h" ] && [ "$last_score_age_h" != "" ] && [ "$last_score_age_h" -gt "$(( WHOOP_STALE_HOURS ))" ] 2>/dev/null; then
      reason="no Whoop recovery data for ${last_score_age_h}h (threshold ${WHOOP_STALE_HOURS}h) and trainer is not alerting about it"
    fi
  fi

  if [ -z "$reason" ]; then
    if [ -f "$WHOOP_ALERT_STATE" ]; then
      send_tg "✅ trainer Whoop freshness recovered @ ${NOW_UTC}."
      rm -f "$WHOOP_ALERT_STATE"
    fi
  else
    local last
    last=$(cat "$WHOOP_ALERT_STATE" 2>/dev/null || echo "")
    if [ "$last" != "$HOUR_KEY" ]; then
      echo "$HOUR_KEY" > "$WHOOP_ALERT_STATE"
      send_tg "🚨 trainer Whoop freshness @ ${NOW_UTC} — ${reason}. Inspect: ssh acemagic \"sqlite3 -readonly ${WHOOP_DB} 'SELECT status,dead_reason,dead_at FROM oauth_tokens'\""
      echo "alerted: whoop-freshness ${reason}"
    fi
  fi
}

check_whoop_freshness

# --- mp-finance-db backup staleness (secondary, on-box layer) ---------------
# Primary dead-man's switch is the off-box Uptime Kuma push from backup.sh (it
# survives acemagic dying). This is the fast, detailed on-box backstop: it reads
# the PASS/FAIL ground-truth state file (written from a REAL scratch restore +
# BYTEA byte-count), NOT mere file existence — a structurally-valid-but-empty
# dump still screams. Backups run every 12h; alert if the last good run is >26h.
MPF_STATE="${STATE_DIR}/mp-finance-last-verify.txt"
MPF_ALERT="${STATE_DIR}/mp-finance-backup-alert.txt"
MPF_REASON=""
if [ ! -f "$MPF_STATE" ]; then
  MPF_REASON="no verify-state file (backup never completed a PASS)"
else
  MPF_LINE=$(cat "$MPF_STATE" 2>/dev/null || echo "")
  MPF_AGE_H=$(( ( $(date -u +%s) - $(stat -c %Y "$MPF_STATE" 2>/dev/null || echo 0) ) / 3600 ))
  case "$MPF_LINE" in
    FAIL*)  MPF_REASON="last run FAILED: ${MPF_LINE#FAIL }" ;;
    PASS*)  [ "$MPF_AGE_H" -gt 26 ] && MPF_REASON="last good backup ${MPF_AGE_H}h ago (>26h) — schedule may be dead"
            case "$MPF_LINE" in *attach_bytes=0*) MPF_REASON="last 'PASS' has attach_bytes=0 (binary data missing)";; esac ;;
    *)      MPF_REASON="unrecognized verify-state: ${MPF_LINE}" ;;
  esac
fi
if [ -z "$MPF_REASON" ]; then
  if [ -f "$MPF_ALERT" ]; then
    send_tg "✅ mp-finance-db backup recovered @ ${NOW_UTC} ($(cat "$MPF_STATE" 2>/dev/null))."
    rm -f "$MPF_ALERT"
  fi
else
  LAST=$(cat "$MPF_ALERT" 2>/dev/null || echo "")
  if [ "$LAST" != "$HOUR_KEY" ]; then
    echo "$HOUR_KEY" > "$MPF_ALERT"
    send_tg "🚨 mp-finance-db BACKUP problem @ ${NOW_UTC} — ${MPF_REASON}. The Atlas/comp+finance DB may be unprotected. Check: journalctl -u mp-finance-backup -n 50; cat ${MPF_STATE}"
  fi
fi

# ─── Callback inline-button EDIT-FAILURE probe ───────────────────────────────
# The dead-observer fix for the Jun-2026 Findlays order-ack bug: every inline-
# button edit failed "400 message to edit not found" for ~2 weeks (8 acks)
# because the running framework dist resolved messageId from the callback-query
# id, and nothing watched. A bot can RECORD an action while its visible
# confirmation silently fails — logs aren't a check. Watch the edit error
# directly, across the fleet, over a rolling window ≥ the 5-min cron interval.
EDIT_FAIL_ALERT="${STATE_DIR}/callback-edit-fail-alert.txt"
EDIT_FAIL_SINCE=$(date -u -d '65 minutes ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null)
EDIT_FAIL_HITS=""
if [ -n "$EDIT_FAIL_SINCE" ]; then
  for SVC in botforge-hali99 botforge-kristina botforge-maia botforge-trainer; do
    N=$(journalctl -u "$SVC" --since "$EDIT_FAIL_SINCE" --no-pager 2>/dev/null | grep -c "message to edit not found")
    [ "${N:-0}" -gt 0 ] && EDIT_FAIL_HITS="${EDIT_FAIL_HITS}${SVC#botforge-}:${N} "
  done
fi
if [ -z "$EDIT_FAIL_HITS" ]; then
  if [ -f "$EDIT_FAIL_ALERT" ]; then
    send_tg "✅ Bot button-edits recovered @ ${NOW_UTC} — no 'message to edit not found' in last 65min."
    rm -f "$EDIT_FAIL_ALERT"
  fi
else
  LAST=$(cat "$EDIT_FAIL_ALERT" 2>/dev/null || echo "")
  if [ "$LAST" != "$HOUR_KEY" ]; then
    echo "$HOUR_KEY" > "$EDIT_FAIL_ALERT"
    send_tg "🚨 Bot inline-button edits FAILING @ ${NOW_UTC} — 'message to edit not found': ${EDIT_FAIL_HITS}. Acks/approvals RECORD but show no confirmation (likely stale framework dist / messageId resolution). Check: journalctl -u botforge-<bot> | grep 'edit failed'"
  fi
fi
