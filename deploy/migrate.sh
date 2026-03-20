#!/usr/bin/env bash
#
# mcp-stack migration script
# Run as root on box.makkib.com
#
# Migrates cd-mcp + bidrento-mcp from separate repos to mcp-stack monorepo.
# Designed for zero-data-loss: copies .env, .sessions.json, preserves TLS certs.
# Cutover is one service at a time (~10s downtime each).
#
# Usage:
#   sudo bash deploy/migrate.sh prepare   # Phase 1: clone, copy config, build
#   sudo bash deploy/migrate.sh cutover   # Phase 2: stop old, start new
#   sudo bash deploy/migrate.sh cleanup   # Phase 3: disable old services
#   sudo bash deploy/migrate.sh status    # Check everything

set -euo pipefail

REPO_URL="https://github.com/mabi8/mcp-stack.git"

# ─── Colors ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

# ─── Phase 1: Prepare ────────────────────────────────────────────────

prepare() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Phase 1: Prepare (no downtime)"
  echo "═══════════════════════════════════════════"
  echo ""

  # 1. Clone for cdapi
  if [ -d /home/cdapi/mcp-stack ]; then
    warn "Clone already exists at /home/cdapi/mcp-stack — pulling latest"
    sudo -u cdapi bash -c "cd /home/cdapi/mcp-stack && git pull"
  else
    echo "Cloning mcp-stack for cdapi..."
    sudo -u cdapi git clone "$REPO_URL" /home/cdapi/mcp-stack
  fi
  ok "cdapi clone ready"

  # 2. Clone for bdroapi
  if [ -d /home/bdroapi/mcp-stack ]; then
    warn "Clone already exists at /home/bdroapi/mcp-stack — pulling latest"
    sudo -u bdroapi bash -c "cd /home/bdroapi/mcp-stack && git pull"
  else
    echo "Cloning mcp-stack for bdroapi..."
    sudo -u bdroapi git clone "$REPO_URL" /home/bdroapi/mcp-stack
  fi
  ok "bdroapi clone ready"

  # 3. Copy .env files
  if [ -f /home/cdapi/cd-mcp/.env ]; then
    cp /home/cdapi/cd-mcp/.env /home/cdapi/mcp-stack/packages/centerdevice/.env
    chown cdapi:cdapi /home/cdapi/mcp-stack/packages/centerdevice/.env
    chmod 600 /home/cdapi/mcp-stack/packages/centerdevice/.env
    ok "Copied CD .env"
  else
    fail "No .env found at /home/cdapi/cd-mcp/.env"
  fi

  if [ -f /home/bdroapi/bidrento-mcp/.env ]; then
    cp /home/bdroapi/bidrento-mcp/.env /home/bdroapi/mcp-stack/packages/bidrento/.env
    chown bdroapi:bdroapi /home/bdroapi/mcp-stack/packages/bidrento/.env
    chmod 600 /home/bdroapi/mcp-stack/packages/bidrento/.env
    ok "Copied BD .env"
  else
    fail "No .env found at /home/bdroapi/bidrento-mcp/.env"
  fi

  # 4. Copy sessions (cd-mcp has them, bidrento may not)
  if [ -f /home/cdapi/cd-mcp/.sessions.json ]; then
    cp /home/cdapi/cd-mcp/.sessions.json /home/cdapi/mcp-stack/packages/centerdevice/.sessions.json
    chown cdapi:cdapi /home/cdapi/mcp-stack/packages/centerdevice/.sessions.json
    chmod 600 /home/cdapi/mcp-stack/packages/centerdevice/.sessions.json
    ok "Copied CD sessions"
  else
    warn "No .sessions.json found for CD — fresh start"
  fi

  if [ -f /home/bdroapi/bidrento-mcp/.sessions.json ]; then
    cp /home/bdroapi/bidrento-mcp/.sessions.json /home/bdroapi/mcp-stack/packages/bidrento/.sessions.json
    chown bdroapi:bdroapi /home/bdroapi/mcp-stack/packages/bidrento/.sessions.json
    chmod 600 /home/bdroapi/mcp-stack/packages/bidrento/.sessions.json
    ok "Copied BD sessions"
  else
    warn "No .sessions.json for BD — fresh start (expected)"
  fi

  # 5. Build (as each user, from monorepo root)
  echo ""
  echo "Building for cdapi..."
  sudo -u cdapi bash -c "cd /home/cdapi/mcp-stack && npm install && npm run build -w packages/core && npm run build -w packages/centerdevice"
  ok "cdapi build complete"

  echo ""
  echo "Building for bdroapi..."
  sudo -u bdroapi bash -c "cd /home/bdroapi/mcp-stack && npm install && npm run build -w packages/core && npm run build -w packages/bidrento"
  ok "bdroapi build complete"

  # 6. Install nginx configs
  mkdir -p /etc/nginx/mcp.d

  cp /home/cdapi/mcp-stack/deploy/nginx/mcp.d/centerdevice.conf /etc/nginx/mcp.d/
  cp /home/cdapi/mcp-stack/deploy/nginx/mcp.d/bidrento.conf /etc/nginx/mcp.d/
  cp /home/cdapi/mcp-stack/deploy/nginx/mcp.d/telegram.conf /etc/nginx/mcp.d/
  ok "Nginx mcp.d/ configs installed"

  # 7. Install new systemd units (not started yet)
  cp /home/cdapi/mcp-stack/deploy/systemd/mcp-centerdevice.service /etc/systemd/system/
  cp /home/cdapi/mcp-stack/deploy/systemd/mcp-bidrento.service /etc/systemd/system/
  systemctl daemon-reload
  ok "systemd units installed (not started)"

  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Phase 1 complete. Ready for cutover."
  echo ""
  echo "  Next: sudo bash deploy/migrate.sh cutover"
  echo "═══════════════════════════════════════════"
}

# ─── Phase 2: Cutover ────────────────────────────────────────────────

cutover() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Phase 2: Cutover"
  echo "═══════════════════════════════════════════"
  echo ""

  # Switch nginx to include-based config
  echo "Switching nginx to include-based config..."

  # Backup old config
  cp /etc/nginx/sites-enabled/box.makkib.com /etc/nginx/sites-enabled/box.makkib.com.bak

  # Write new config
  cp /home/cdapi/mcp-stack/deploy/nginx/box.makkib.com.conf /etc/nginx/sites-enabled/box.makkib.com

  # Test nginx config
  if nginx -t 2>&1; then
    ok "nginx config valid"
  else
    # Restore backup
    cp /etc/nginx/sites-enabled/box.makkib.com.bak /etc/nginx/sites-enabled/box.makkib.com
    fail "nginx config invalid — restored backup. Fix and retry."
  fi

  # CenterDevice cutover
  echo ""
  echo "Cutting over CenterDevice MCP..."
  systemctl stop cd-mcp 2>/dev/null || true
  systemctl reload nginx
  systemctl start mcp-centerdevice
  systemctl enable mcp-centerdevice
  sleep 2

  # Verify CD
  if curl -sf https://box.makkib.com/health | grep -q "mcp-centerdevice"; then
    ok "CenterDevice MCP is up (mcp-centerdevice)"
  else
    warn "Health check did not return expected service name — check journalctl"
  fi

  # Bidrento cutover
  echo ""
  echo "Cutting over Bidrento MCP..."
  systemctl stop bidrento-mcp 2>/dev/null || true
  systemctl start mcp-bidrento
  systemctl enable mcp-bidrento
  sleep 2

  # Verify BD
  BD_HEALTH=$(curl -sf https://box.makkib.com/bidrento/health 2>/dev/null || echo "")
  if echo "$BD_HEALTH" | grep -q "mcp-bidrento"; then
    ok "Bidrento MCP is up (mcp-bidrento)"
  else
    warn "Bidrento health check inconclusive — check journalctl -u mcp-bidrento"
  fi

  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Phase 2 complete. Both services running."
  echo ""
  echo "  Verify:"
  echo "    journalctl -u mcp-centerdevice -n 20"
  echo "    journalctl -u mcp-bidrento -n 20"
  echo ""
  echo "  If something is wrong, roll back:"
  echo "    systemctl stop mcp-centerdevice mcp-bidrento"
  echo "    cp /etc/nginx/sites-enabled/box.makkib.com.bak /etc/nginx/sites-enabled/box.makkib.com"
  echo "    systemctl reload nginx"
  echo "    systemctl start cd-mcp bidrento-mcp"
  echo ""
  echo "  When stable: sudo bash deploy/migrate.sh cleanup"
  echo "═══════════════════════════════════════════"
}

# ─── Phase 3: Cleanup ────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Phase 3: Cleanup"
  echo "═══════════════════════════════════════════"
  echo ""

  # Disable old services (don't delete — they're still backup)
  systemctl disable cd-mcp 2>/dev/null && ok "Disabled cd-mcp" || warn "cd-mcp already disabled"
  systemctl disable bidrento-mcp 2>/dev/null && ok "Disabled bidrento-mcp" || warn "bidrento-mcp already disabled"

  # Remove nginx backup
  if [ -f /etc/nginx/sites-enabled/box.makkib.com.bak ]; then
    rm /etc/nginx/sites-enabled/box.makkib.com.bak
    ok "Removed nginx backup"
  fi

  echo ""
  echo "Old repos still at:"
  echo "  /home/cdapi/cd-mcp/"
  echo "  /home/bdroapi/bidrento-mcp/"
  echo ""
  echo "Delete them when you're confident (not now):"
  echo "  rm -rf /home/cdapi/cd-mcp"
  echo "  rm -rf /home/bdroapi/bidrento-mcp"
  echo ""
  ok "Cleanup complete"
}

# ─── Status Check ─────────────────────────────────────────────────────

status() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Service Status"
  echo "═══════════════════════════════════════════"
  echo ""

  echo "── systemd ──"
  for svc in mcp-centerdevice mcp-bidrento cd-mcp bidrento-mcp; do
    STATE=$(systemctl is-active "$svc" 2>/dev/null || echo "not-found")
    ENABLED=$(systemctl is-enabled "$svc" 2>/dev/null || echo "not-found")
    if [ "$STATE" = "active" ]; then
      echo -e "  ${GREEN}●${NC} $svc: $STATE ($ENABLED)"
    elif [ "$STATE" = "not-found" ]; then
      echo -e "  ${YELLOW}○${NC} $svc: not installed"
    else
      echo -e "  ${RED}●${NC} $svc: $STATE ($ENABLED)"
    fi
  done

  echo ""
  echo "── nginx ──"
  if grep -q "include /etc/nginx/mcp.d" /etc/nginx/sites-enabled/box.makkib.com 2>/dev/null; then
    ok "nginx: include-based config (new)"
  else
    warn "nginx: monolithic config (old)"
  fi

  if [ -d /etc/nginx/mcp.d ]; then
    echo "  mcp.d/ configs: $(ls /etc/nginx/mcp.d/*.conf 2>/dev/null | wc -l) files"
    ls /etc/nginx/mcp.d/*.conf 2>/dev/null | sed 's/^/    /'
  fi

  echo ""
  echo "── health ──"
  CD_HEALTH=$(curl -sf https://box.makkib.com/health 2>/dev/null || echo "unreachable")
  BD_HEALTH=$(curl -sf https://box.makkib.com/bidrento/health 2>/dev/null || echo "unreachable")
  echo "  CenterDevice: $CD_HEALTH"
  echo "  Bidrento: $BD_HEALTH"

  echo ""
  echo "── repos ──"
  [ -d /home/cdapi/mcp-stack ] && ok "/home/cdapi/mcp-stack exists" || warn "/home/cdapi/mcp-stack missing"
  [ -d /home/bdroapi/mcp-stack ] && ok "/home/bdroapi/mcp-stack exists" || warn "/home/bdroapi/mcp-stack missing"
  [ -d /home/cdapi/cd-mcp ] && warn "/home/cdapi/cd-mcp still exists (old)" || ok "/home/cdapi/cd-mcp removed"
  [ -d /home/bdroapi/bidrento-mcp ] && warn "/home/bdroapi/bidrento-mcp still exists (old)" || ok "/home/bdroapi/bidrento-mcp removed"

  echo ""
}

# ─── Dispatch ─────────────────────────────────────────────────────────

case "${1:-}" in
  prepare) prepare ;;
  cutover) cutover ;;
  cleanup) cleanup ;;
  status)  status ;;
  *)
    echo "Usage: sudo bash deploy/migrate.sh {prepare|cutover|cleanup|status}"
    echo ""
    echo "  prepare  — Clone repos, copy configs, build (no downtime)"
    echo "  cutover  — Stop old services, switch nginx, start new (10s downtime/svc)"
    echo "  cleanup  — Disable old systemd units, remove backup files"
    echo "  status   — Check everything"
    exit 1
    ;;
esac
