#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# BCL VPS1 Bootstrap — run once as root after ordering the Hetzner VPS
#
# Usage:
#   ssh root@[VPS_IP] 'bash -s' < bootstrap-vps1.sh \
#     SSS_IP=<sss.makkib.com IP> \
#     YOUR_IP=<your personal SSH IP> \
#     BASTION_PUBKEY="<ops@sss public key>"
#
# Or copy to the server and run:
#   SSS_IP=x.x.x.x YOUR_IP=y.y.y.y BASTION_PUBKEY="ssh-ed25519 AAAA..." bash bootstrap-vps1.sh
#
# After this completes, vps-cmd can reach ops@vps1.infra.bcliving.de
# and Claude takes over for Phase 2 (Outline deploy).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Validate inputs ──────────────────────────────────────────────────

if [[ -z "${SSS_IP:-}" || -z "${YOUR_IP:-}" || -z "${BASTION_PUBKEY:-}" ]]; then
  echo "ERROR: Required environment variables not set."
  echo ""
  echo "Usage:"
  echo "  SSS_IP=<bastion IP> YOUR_IP=<your IP> BASTION_PUBKEY=\"ssh-ed25519 ...\" bash bootstrap-vps1.sh"
  exit 1
fi

echo "╔══════════════════════════════════════════════╗"
echo "║  BCL VPS1 Bootstrap                          ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Bastion IP:  ${SSS_IP}"
echo "║  Personal IP: ${YOUR_IP}"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Step 1: System update + base packages ────────────────────────────

echo "→ [1/9] System update + packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git unzip gnupg2 software-properties-common \
  apt-transport-https ca-certificates iptables-persistent fail2ban \
  nginx certbot python3-certbot-nginx

# ── Step 2: Hostname ─────────────────────────────────────────────────

echo "→ [2/9] Setting hostname..."
hostnamectl set-hostname vps1.infra.bcliving.de

# ── Step 3: SSH hardening ────────────────────────────────────────────

echo "→ [3/9] SSH hardening..."
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# ── Step 4: Create ops user ──────────────────────────────────────────

echo "→ [4/9] Creating ops user..."
if ! id ops &>/dev/null; then
  useradd -m -s /bin/bash ops
fi
# Docker group may not exist yet — add after Docker install
echo "ops ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/journalctl, /usr/bin/docker, /usr/bin/docker-compose, /usr/local/bin/docker-compose" > /etc/sudoers.d/ops-nopasswd
chmod 440 /etc/sudoers.d/ops-nopasswd

# ── Step 5: Authorize bastion key ────────────────────────────────────

echo "→ [5/9] Authorizing bastion SSH key for ops..."
mkdir -p /home/ops/.ssh
echo "${BASTION_PUBKEY}" > /home/ops/.ssh/authorized_keys
chown -R ops:ops /home/ops/.ssh
chmod 700 /home/ops/.ssh
chmod 600 /home/ops/.ssh/authorized_keys

# ── Step 6: iptables hardening ───────────────────────────────────────

echo "→ [6/9] Configuring iptables (v4 + v6)..."

# IPv4
iptables -F
iptables -X
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -s "${SSS_IP}" -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -s "${YOUR_IP}" -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# IPv6
ip6tables -F
ip6tables -X
ip6tables -P INPUT DROP
ip6tables -P FORWARD DROP
ip6tables -P OUTPUT ACCEPT
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
ip6tables -A INPUT -p tcp --dport 80 -j ACCEPT
ip6tables -A INPUT -p tcp --dport 443 -j ACCEPT

# Save
iptables-save > /etc/iptables/rules.v4
ip6tables-save > /etc/iptables/rules.v6

# ── Step 7: fail2ban ─────────────────────────────────────────────────

echo "→ [7/9] Configuring fail2ban..."
cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
maxretry = 3
bantime = 3600
findtime = 600
EOF
systemctl enable --now fail2ban

# ── Step 8: Docker ───────────────────────────────────────────────────

echo "→ [8/9] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
usermod -aG docker ops

# ── Step 9: Node.js 22 ──────────────────────────────────────────────

echo "→ [9/9] Installing Node.js 22 LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✓ Bootstrap complete                        ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Hostname: $(hostname)              "
echo "║  Docker:   $(docker --version 2>/dev/null || echo 'not found')"
echo "║  Node:     $(node --version 2>/dev/null || echo 'not found')"
echo "║  ops user: $(id ops 2>/dev/null || echo 'not found')"
echo "╠══════════════════════════════════════════════╣"
echo "║  Next: test bastion SSH from sss.makkib.com  ║"
echo "║  ssh ops@vps1.infra.bcliving.de hostname     ║"
echo "║                                              ║"
echo "║  Then tell Claude to run Phase 2.            ║"
echo "╚══════════════════════════════════════════════╝"
