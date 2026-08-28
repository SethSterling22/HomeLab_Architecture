My DevOps story didn't start with Kubernetes — it started in 2023 with one old laptop turned into a makeshift NAS.

Over time I kept adding laptops as I needed more storage and compute. But the setup grew organically, not intentionally: no centralized visibility, no monitoring, no way to control anything remotely. Every change meant physically sitting down at that one specific machine.

Three months ago I decided to fix that properly. What used to be a pile of disconnected laptops is now a real 6-node homelab: Proxmox for virtualization, k3s for orchestration, Tailscale tying it all together, and Ansible doing the provisioning — one dashboard to see everything, one command to change anything.

Getting there meant solving real problems, not tutorial ones: a NIC driver with no upstream Wake-on-LAN support (patched via DKMS), a laptop that can only wake from suspend rather than a full poweroff, and a Prometheus/Grafana pipeline with real power measurement (a smart plug + a UPS via NUT) to replace guesswork with data.

Two years of "it works, sort of" turned into three months of "it works, and I know exactly why."

#DevOps #HomeLab #SelfHosted #Kubernetes #SRE
