# Portainer Installation

Portainer is deployed as a Kubernetes workload inside the k3s cluster running on Sadida, giving you a web UI to manage all nodes, pods, deployments, namespaces, and logs from a single interface.

---

## Prerequisites

### 1. Set KUBECONFIG

Helm and kubectl require the kubeconfig to be explicitly set on Proxmox, as k3s places it in a non-standard path:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

To make this permanent across sessions, add it to root's profile:

```bash
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> /root/.bashrc
```

### 2. Install Helm

```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

Verify:

```bash
helm version
```

---

## Installation

```bash
# Add the Portainer Helm repository
helm repo add portainer https://portainer.github.io/k8s/
helm repo update

# Create the namespace
kubectl create namespace portainer

# Install Portainer
helm install portainer portainer/portainer \
  --namespace portainer \
  --set service.type=NodePort \
  --set nodePort=30777
```

---

## Verify

```bash
kubectl get pods -n portainer
kubectl get svc -n portainer
```

Wait until the pod status shows `Running` before accessing the UI.

---

## Access

Open the following URL in your browser from any device on the network or via Tailscale:

```
https://192.168.68.10:30777
```

> The browser will show a certificate warning — this is expected. Accept it to continue.

On first access, Portainer will prompt you to create an admin user. **You have 5 minutes to complete this before the setup expires.** If it expires, restart the pod:

```bash
kubectl rollout restart deployment portainer -n portainer
```

---

## What You Can Do

Once logged in, Portainer automatically detects the local k3s cluster and displays all nodes:

| Node | Role |
|------|------|
| sadida | control-plane |
| sram | worker |
| ocra | worker |
| xelor | worker (on-demand) |
| sacro | worker (on-demand) |

From the UI you can:

- View real-time pod status across all nodes
- Stream container logs
- Scale deployments up or down
- Exec into a running container
- Manage namespaces, services, and ingress routes
- View resource usage per node

---

## Managing Docker containers on Sadida, Aery, and Ocra

The install above only covers the k3s cluster (the "local" Kubernetes
environment). Sadida, Aery, and Ocra each **also** run their own standalone
Docker containers outside k3s — those are invisible to Portainer until you
add a separate **Agent** per host, registered as an additional "Docker"
environment inside this same Portainer install. One Portainer server, many
environments — you switch between them from the sidebar.

### 1. Deploy the agent

- **Sadida and Aery** — use `portainer/agent/docker-compose.yaml` at the
  repo root, unmodified, on each host:
  ```bash
  cd portainer/agent
  docker compose up -d
  ```
- **Ocra** — already covered: it's the `portainer-agent` service inside
  `monitoring/docker-compose.yaml`, started/stopped together with the rest
  of that stack (`docker compose up -d` there picks it up).

### 2. Register each as a new environment

In the Portainer UI (`https://192.168.68.10:30777`):

1. **Environments → Add environment → Docker → Agent**
2. Name it (e.g. `sadida-docker`, `aery-docker`, `ocra-docker`)
3. Environment address: `<host's Tailscale IP>:9001`
4. Repeat for each of the three hosts

You'll end up with four environments total: the existing `local` (k3s) one,
plus `sadida-docker`, `aery-docker`, and `ocra-docker`.

### Security

Port 9001 is root-equivalent access to that host's Docker daemon — the same
risk tier as the Control API (`monitoring/control-api/`). Never forward it
through `edge/`'s public Caddy. Keep it reachable over Tailscale/LAN only;
for extra hardening, firewall it so only Sadida's address can reach port
9001 on Aery and Ocra.

---

## Uninstall

```bash
helm uninstall portainer -n portainer
kubectl delete namespace portainer
```
