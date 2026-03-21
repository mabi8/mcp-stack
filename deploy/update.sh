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
  sudo -u cdapi bash -c "cd /home/cdapi/mcp-stack && git pull && npm install && npm run build -w packages/core && npm run build -w packages/centerdevice"
  systemctl restart mcp-centerdevice
  sleep 2
  journalctl -u mcp-centerdevice -n 5 --no-pager
  ok "CenterDevice MCP updated and restarted"
}

update_bidrento() {
  echo "Updating Bidrento MCP..."
  sudo -u bdroapi bash -c "cd /home/bdroapi/mcp-stack && git pull && npm install && npm run build -w packages/core && npm run build -w packages/bidrento"
  systemctl restart mcp-bidrento
  sleep 2
  journalctl -u mcp-bidrento -n 5 --no-pager
  ok "Bidrento MCP updated and restarted"
}

update_vps_cmd() {
  echo "Updating VPS Command MCP..."
  sudo -u ops bash -c "cd /home/ops/mcp-stack && git pull && npm install && npm run build -w packages/core && npm run build -w packages/vps-cmd"
  systemctl restart mcp-vps-cmd
  sleep 2
  journalctl -u mcp-vps-cmd -n 5 --no-pager
  ok "VPS Command MCP updated and restarted"
}

case "${1:-}" in
  all)
    update_centerdevice
    echo ""
    update_bidrento
    echo ""
    update_vps_cmd
    ;;
  centerdevice|cd)
    update_centerdevice
    ;;
  bidrento|bd)
    update_bidrento
    ;;
  vps-cmd|vps)
    update_vps_cmd
    ;;
  *)
    echo "Usage: sudo bash deploy/update.sh {all|centerdevice|bidrento|vps-cmd}"
    exit 1
    ;;
esac
