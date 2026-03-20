#!/usr/bin/env bash
#
# mcp-stack update script
# Run as root on box.makkib.com AFTER migration is complete.
#
# Updates one or both MCP services from git, rebuilds, and restarts.
#
# Usage:
#   sudo bash deploy/update.sh all          # Update both
#   sudo bash deploy/update.sh centerdevice # Update CD only
#   sudo bash deploy/update.sh bidrento     # Update BD only

set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'
ok() { echo -e "${GREEN}✓${NC} $1"; }

update_centerdevice() {
  echo "Updating CenterDevice MCP..."
  sudo -u cdapi bash -c "cd /home/cdapi/mcp-stack && git pull && npm ci && npm run build -w packages/core && npm run build -w packages/centerdevice"
  systemctl restart mcp-centerdevice
  sleep 2
  journalctl -u mcp-centerdevice -n 5 --no-pager
  ok "CenterDevice MCP updated and restarted"
}

update_bidrento() {
  echo "Updating Bidrento MCP..."
  sudo -u bdroapi bash -c "cd /home/bdroapi/mcp-stack && git pull && npm ci && npm run build -w packages/core && npm run build -w packages/bidrento"
  systemctl restart mcp-bidrento
  sleep 2
  journalctl -u mcp-bidrento -n 5 --no-pager
  ok "Bidrento MCP updated and restarted"
}

case "${1:-}" in
  all)
    update_centerdevice
    echo ""
    update_bidrento
    ;;
  centerdevice|cd)
    update_centerdevice
    ;;
  bidrento|bd)
    update_bidrento
    ;;
  *)
    echo "Usage: sudo bash deploy/update.sh {all|centerdevice|bidrento}"
    exit 1
    ;;
esac
