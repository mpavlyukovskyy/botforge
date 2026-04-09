#!/usr/bin/env bash
set -euo pipefail

echo "=== TaskBot Deploy ==="

# 1. Build locally
echo "Building..."
npm run build

# 2. Backup current dist on server
echo "Backing up current deployment..."
ssh openclaw 'cd /opt/taskbot && if [ -d dist ]; then cp -r dist dist.prev; fi'

# 3. Upload new dist + schema
echo "Uploading new build..."
ssh openclaw 'rm -rf /opt/taskbot/dist.new'
scp -r dist openclaw:/opt/taskbot/dist.new
scp package.json package-lock.json openclaw:/opt/taskbot/
scp src/db/schema.sql openclaw:/opt/taskbot/src/db/schema.sql

# 4. Atomic swap
echo "Swapping dist directories..."
ssh openclaw 'cd /opt/taskbot && mv dist dist.old 2>/dev/null; mv dist.new dist && rm -rf dist.old'

# 5. Install deps
echo "Installing dependencies..."
ssh openclaw 'cd /opt/taskbot && npm install --production --silent'

# 6. Restart
echo "Restarting service..."
ssh openclaw 'sudo systemctl restart taskbot'

# 7. Health check
echo "Waiting for service to start (10s)..."
sleep 10

if ssh openclaw 'sudo systemctl is-active taskbot' > /dev/null 2>&1; then
  HEALTH=$(ssh openclaw 'curl -sf http://localhost:8088/api/health 2>/dev/null || echo "{\"status\":\"unknown\"}"')
  echo "Service active. Health: $HEALTH"
  echo "=== Deploy successful ==="
else
  echo "!!! SERVICE FAILED TO START !!!"
  ssh openclaw 'journalctl -u taskbot --no-pager -n 20'
  echo "To rollback: ssh openclaw 'cd /opt/taskbot && rm -rf dist && mv dist.prev dist && sudo systemctl restart taskbot'"
  exit 1
fi
