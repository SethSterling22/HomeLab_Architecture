#!/usr/bin/env bash
# scripts/bootstrap/node-init.sh
# Ejecutar una sola vez en un nodo Debian 12 recién instalado
# Prepara el nodo para ser gestionado por Ansible
# Uso: curl -fsSL <URL>/node-init.sh | sudo bash -s -- --hostname sram --ssh-key "ssh-ed25519 AAAA..."
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[init]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Parsear args ──────────────────────────────────────────────────
HOSTNAME=""
SSH_KEY=""
ENABLE_WOL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)  HOSTNAME="$2"; shift 2 ;;
    --ssh-key)   SSH_KEY="$2";  shift 2 ;;
    --enable-wol) ENABLE_WOL=true; shift ;;
    *) err "Argumento desconocido: $1" ;;
  esac
done

[[ -z "$HOSTNAME" ]] && err "Falta --hostname"
[[ $(id -u) -ne 0 ]]  && err "Debe ejecutarse como root (sudo)"

# ── Setup ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  HomeLab — Node Init para: ${CYAN}${HOSTNAME}${NC}"
echo ""

log "Configurando hostname..."
hostnamectl set-hostname "$HOSTNAME"
echo "127.0.1.1 ${HOSTNAME}" >> /etc/hosts

log "Actualizando sistema..."
apt-get update -qq
apt-get upgrade -y -qq

log "Instalando paquetes esenciales..."
apt-get install -y -qq \
  curl wget git sudo openssh-server \
  net-tools iotop htop \
  python3 python3-pip \
  wakeonlan ethtool

log "Creando usuario 'ubuntu' con sudo..."
if ! id ubuntu &>/dev/null; then
  useradd -m -s /bin/bash -G sudo ubuntu
  echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu
  chmod 440 /etc/sudoers.d/ubuntu
  ok "Usuario ubuntu creado"
else
  ok "Usuario ubuntu ya existe"
fi

if [[ -n "$SSH_KEY" ]]; then
  log "Instalando llave SSH pública..."
  mkdir -p /home/ubuntu/.ssh
  echo "$SSH_KEY" > /home/ubuntu/.ssh/authorized_keys
  chmod 700 /home/ubuntu/.ssh
  chmod 600 /home/ubuntu/.ssh/authorized_keys
  chown -R ubuntu:ubuntu /home/ubuntu/.ssh
  ok "Llave SSH instalada"
fi

log "Endureciendo SSH..."
cat > /etc/ssh/sshd_config.d/hardening.conf << 'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
X11Forwarding no
AllowTcpForwarding yes
EOF
systemctl restart sshd

if [[ "$ENABLE_WOL" == "true" ]]; then
  log "Habilitando Wake-on-LAN..."
  NIC=$(ip route show default | awk '/default/ {print $5}' | head -1)
  if [[ -n "$NIC" ]]; then
    ethtool -s "$NIC" wol g || warn "No se pudo configurar WOL en $NIC — verifica BIOS"
    # Persistir WOL en cada boot
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
    ok "WOL habilitado en $NIC"
    log "MAC address: $(ip link show $NIC | awk '/ether/ {print $2}')"
  else
    warn "No se detectó NIC por defecto para WOL"
  fi
fi

log "Deshabilitando swap..."
swapoff -a
sed -i '/ swap / s/^/#/' /etc/fstab

log "Configurando parámetros de kernel para k3s..."
cat > /etc/sysctl.d/99-k3s.conf << 'EOF'
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                  = 1
vm.max_map_count                     = 262144
EOF
sysctl --system -q

echo ""
ok "Nodo ${HOSTNAME} listo para Ansible"
echo ""
echo "  Próximos pasos:"
echo "    1. Añade '${HOSTNAME}' al inventario Ansible con su IP"
echo "    2. Ejecuta: ansible-playbook ansible/playbooks/bootstrap.yml --limit ${HOSTNAME}"
echo "    3. Luego:   ansible-playbook ansible/playbooks/k3s.yml --limit ${HOSTNAME}"
echo ""
