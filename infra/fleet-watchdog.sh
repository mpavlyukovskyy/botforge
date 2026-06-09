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
# Usage: fleet-watchdog.sh [--selftest]
#   --selftest  send a test DM to verify the alert channel, then exit

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
)

send_tg() {
  curl -sS --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${ALERT_CHAT}" \
    --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--selftest" ]; then
  send_tg "🔧 fleet-watchdog selftest OK @ ${NOW_UTC} (monitoring: hali99, chief-of-staff, trainer, taskbot)"
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
