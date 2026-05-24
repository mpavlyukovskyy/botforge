#!/usr/bin/env bash
# Definition-of-Done chaos test. Run quarterly per docs/quarterly-review.md.
#
# What it does:
#   1. Pick one bot at random (or BOT="botforge-trainer" override).
#   2. Stop it via systemctl.
#   3. Wait 11 minutes (Uptime Kuma typical alert threshold is 10min idle).
#   4. Restart the bot.
#   5. Prompt the operator to confirm: (a) Kuma sent an alert, (b) the
#      framework's recovery DM landed, (c) the bot's health endpoint is
#      back to status=healthy.
#
# Failure of any of (a)/(b)/(c) means the heartbeat + alerting chain is
# broken. Fix before next quarterly cycle.

set -euo pipefail

BOT="${BOT:-}"
ACEMAGIC_SSH="${ACEMAGIC_SSH:-acemagic}"
DOWNTIME_SECONDS="${DOWNTIME_SECONDS:-660}"  # 11 min

ALL_BOTS=(botforge-trainer botforge-chief-of-staff botforge-kristina)

if [[ -z "$BOT" ]]; then
  BOT="${ALL_BOTS[$((RANDOM % ${#ALL_BOTS[@]}))]}"
fi

echo "🔥 DoD chaos test: $BOT will be stopped for ${DOWNTIME_SECONDS}s."
echo "   Confirm Kuma + recovery DM. Press Ctrl+C within 5s to abort."
sleep 5

case "$BOT" in
  *trainer)         PORT=8092 ;;
  *chief-of-staff)  PORT=8091 ;;
  *kristina)        PORT=8087 ;;
  *) echo "Unknown bot $BOT"; exit 1 ;;
esac

# Pre-flight: confirm currently healthy.
PRE_HEALTH=$(ssh "$ACEMAGIC_SSH" "curl -sf http://localhost:$PORT/api/health" || echo "{}")
echo "Pre-flight health: $PRE_HEALTH"
if ! echo "$PRE_HEALTH" | grep -q '"status":"healthy"'; then
  echo "❌ Bot is not healthy before the test. Aborting." >&2
  exit 1
fi

echo "→ Stopping $BOT at $(date -Iseconds)..."
ssh "$ACEMAGIC_SSH" "sudo systemctl stop $BOT"

echo "→ Sleeping ${DOWNTIME_SECONDS}s. Watch your phone for the Kuma alert."
sleep "$DOWNTIME_SECONDS"

echo "→ Restarting $BOT at $(date -Iseconds)..."
ssh "$ACEMAGIC_SSH" "sudo systemctl start $BOT"

# Wait for health to recover.
for i in {1..12}; do
  sleep 5
  POST_HEALTH=$(ssh "$ACEMAGIC_SSH" "curl -sf http://localhost:$PORT/api/health" || echo "{}")
  if echo "$POST_HEALTH" | grep -q '"status":"healthy"'; then
    echo "✓ $BOT healthy again ($((i * 5))s after restart)."
    break
  fi
  echo "  ($i/12) not healthy yet — waiting..."
done

echo
echo "==============================="
echo "  Chaos test complete."
echo "==============================="
echo "Verify manually:"
echo "  [ ] You received a Kuma alert for $BOT during the ${DOWNTIME_SECONDS}s window."
echo "  [ ] You received a recovery DM after the bot came back."
echo "  [ ] /api/health shows the bot status=healthy."
echo
echo "If any of the above failed, file an issue and fix BEFORE next quarterly review."
