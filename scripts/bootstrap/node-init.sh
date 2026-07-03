#!/usr/bin/env bash
# scripts/bootstrap/node-init.sh
# Run once on a freshly installed Debian 13 (Trixie) node.
# Prepares the node to be managed by Ansible.
# Usage: curl -fsSL <URL>/node-init.sh | sudo bash -s -- --hostname sram --ssh-key "ssh-ed25519 AAAA..."
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[init]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Parse args ────────────────────────────────────────────────────
HOSTNAME=""
SSH_KEY=""
ENABLE_WOL=false
ADMIN_USER="seth"   # standard admin user across all nodes

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)  HOSTNAME="$2"; shift 2 ;;
    --ssh-key)   SSH_KEY="$2";  shift 2 ;;
    --enable-wol) ENABLE_WOL=true; shift ;;
    *) err "Unknown argument: $1" ;;
  esac
done

[[ -z "$HOSTNAME" ]] && err "Missing --hostname"
[[ $(id -u) -ne 0 ]]  && err "Must be run as root (sudo)"

# ── Setup ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  HomeLab — Node Init for: ${CYAN}${HOSTNAME}${NC}"
echo ""

log "Setting hostname..."
hostnamectl set-hostname "$HOSTNAME"
echo "127.0.1.1 ${HOSTNAME}" >> /etc/hosts

log "Updating the system..."
apt-get update -qq
apt-get upgrade -y -qq

log "Installing essential packages..."
apt-get install -y -qq \
  curl wget git sudo openssh-server \
  net-tools iotop htop \
  python3 python3-pip \
  wakeonlan ethtool

log "Creating user '${ADMIN_USER}' with sudo..."
if ! id "$ADMIN_USER" &>/dev/null; then
  useradd -m -s /bin/bash -G sudo "$ADMIN_USER"
  echo "${ADMIN_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${ADMIN_USER}"
  chmod 440 "/etc/sudoers.d/${ADMIN_USER}"
  ok "User ${ADMIN_USER} created"
else
  ok "User ${ADMIN_USER} already exists"
fi

if [[ -n "$SSH_KEY" ]]; then
  log "Installing public SSH key..."
  mkdir -p "/home/${ADMIN_USER}/.ssh"
  echo "$SSH_KEY" > "/home/${ADMIN_USER}/.ssh/authorized_keys"
  chmod 700 "/home/${ADMIN_USER}/.ssh"
  chmod 600 "/home/${ADMIN_USER}/.ssh/authorized_keys"
  chown -R "${ADMIN_USER}:${ADMIN_USER}" "/home/${ADMIN_USER}/.ssh"
  ok "SSH key installed"
fi

log "Hardening SSH..."
cat > /etc/ssh/sshd_config.d/hardening.conf << 'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
X11Forwarding no
AllowTcpForwarding yes
EOF
systemctl restart sshd

if [[ "$ENABLE_WOL" == "true" ]]; then
  log "Enabling Wake-on-LAN..."
  NIC=$(ip route show default | awk '/default/ {print $5}' | head -1)
  if [[ -n "$NIC" ]]; then
    ethtool -s "$NIC" wol g || warn "Could not configure WOL on $NIC — check the BIOS"
    # Persist WOL on every boot
    cat > /etc/systemd/system/wol.service << EOF
[Unit]
Description=Enable Wake-on-LAN for ${NIC}
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/ethtool -s ${NIC} wol g
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now wol.service
    ok "WOL enabled on $NIC"
    log "MAC address: $(ip link show $NIC | awk '/ether/ {print $2}')"
  else
    warn "No default NIC detected for WOL"
  fi
fi

log "Disabling swap..."
swapoff -a
sed -i '/ swap / s/^/#/' /etc/fstab

log "Configuring kernel parameters for k3s..."
cat > /etc/sysctl.d/99-k3s.conf << 'EOF'
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                  = 1
vm.max_map_count                     = 262144
EOF
sysctl --system -q

echo ""
ok "Node ${HOSTNAME} is ready for Ansible"
echo ""
echo "  Next steps:"
echo "    1. Add '${HOSTNAME}' to the Ansible inventory with its IP"
echo "    2. Run: ansible-playbook ansible/playbooks/bootstrap.yml --limit ${HOSTNAME}"
echo "    3. Then: ansible-playbook ansible/playbooks/k3s.yml --limit ${HOSTNAME}"
echo ""
