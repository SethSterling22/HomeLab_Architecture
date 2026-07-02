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

## Uninstall

```bash
helm uninstall portainer -n portainer
kubectl delete namespace portainer
```
