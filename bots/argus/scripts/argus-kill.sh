#!/usr/bin/env bash
#
# argus-kill.sh — SSH-based kill switch, independent of Telegram
#
# Usage:
#   ssh openclaw '/opt/botforge/bots/argus/scripts/argus-kill.sh'
#
# This script hits the Argus health API to trigger the kill switch.
# Falls back to sending SIGTERM to the bot process if the API is unreachable.
#

set -euo pipefail

HEALTH_PORT=8088
KILL_ENDPOINT="http://127.0.0.1:${HEALTH_PORT}/api/kill"
SERVICE_NAME="botforge-argus"

echo "=== ARGUS KILL SWITCH ==="
echo "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Method 1: Try the health API kill endpoint
if command -v curl &>/dev/null; then
  echo "Attempting kill via API..."
  HTTP_CODE=$(curl -s -o /tmp/argus-kill-response.txt -w "%{http_code}" \
    -X POST "${KILL_ENDPOINT}" \
    -H "Authorization: Bearer ${HEALTH_API_TOKEN:-}" \
    -H "Content-Type: application/json" \
    --max-time 10 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "Kill switch activated via API (HTTP ${HTTP_CODE})"
    cat /tmp/argus-kill-response.txt 2>/dev/null
    echo ""
    echo "=== KILL SWITCH COMPLETE ==="
    exit 0
  else
    echo "API kill failed (HTTP ${HTTP_CODE}), falling back to process kill..."
  fi
fi

# Method 2: Stop the systemd service
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  echo "Stopping ${SERVICE_NAME} service..."
  sudo systemctl stop "${SERVICE_NAME}"
  echo "Service stopped."
else
  echo "Service ${SERVICE_NAME} not found or not active."

  # Method 3: Kill the node process directly
  PIDS=$(pgrep -f "botforge.*argus" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "Killing Argus processes: ${PIDS}"
    kill -TERM $PIDS 2>/dev/null || true
    sleep 2
    # Force kill if still running
    kill -9 $PIDS 2>/dev/null || true
    echo "Processes terminated."
  else
    echo "No Argus processes found."
  fi
fi

echo ""
echo "=== KILL SWITCH COMPLETE ==="
echo "WARNING: Positions may still be open on exchanges."
echo "Check Hyperliquid and Arbitrum manually."
