# WOL Scripts
 
Scripts for remote power management of all cluster nodes from Sadida.
 
---
 
## Scripts
 
| Script | Description |
|--------|-------------|
| `wake.sh` | Sends a WOL magic packet to wake one or all nodes |
| `shutdown.sh` | Safely drains a node from k3s and powers it off |
 
---
 
## Node Reference
 
| Node | IP | MAC | WOL Method | Always On |
|------|----|-----|------------|-----------|
| sram | 192.168.68.108 | d8:9e:f3:89:8a:24 | `shutdown -h now` | Yes |
| ocra | 100.107.52.17 (Tailscale — see note below) | *(no WOL — not a target)* | `shutdown -h now` | Yes |
| xelor | 192.168.68.114 | 88:ae:1d:6c:e4:06 | `shutdown -h now` | No |
| sacro | 192.168.68.115 | 68:f7:28:83:d6:77 | `systemctl suspend` | No |

> **Ocra's IP is its Tailscale address, not a LAN IP.** Ocra is the only
> WiFi-connected node here (everything else is Ethernet), and its LAN DHCP
> lease has been observed drifting over time (192.168.68.100 -> .103). It
> is also not a WOL target at all — see "How WOL Works" below for why WiFi
> disqualifies it. The Tailscale IP above is only used for the
> ping-liveness checks in `wake.sh`/`status.sh`.
 
---
 
## Usage
 
```bash
# Wake a node
./wake.sh xelor
./wake.sh sacro
./wake.sh all
 
# Shut down a node (drains k3s pods first)
./shutdown.sh xelor
./shutdown.sh sacro
./shutdown.sh all
 
# Shut down immediately without draining pods
./shutdown.sh all --skip-drain
```
 
---
 
## Prerequisites — sudoers configuration
 
Each worker node requires passwordless sudo for the shutdown command so the scripts can execute remotely over SSH without an interactive terminal.
 
### All nodes (sram, ocra, xelor, sacro)
 
Run as root on each node:
 
```bash
echo "seth ALL=(ALL) NOPASSWD: /sbin/shutdown" > /etc/sudoers.d/shutdown
chmod 440 /etc/sudoers.d/shutdown
```
 
### Sacro only — additional suspend permission
 
Sacro has an **InsydeH20 BIOS** that does not maintain power to the NIC after a full poweroff (S5) or hibernate (S4). WOL magic packets are only received when the machine is in **suspend (S3)**, which keeps a small current running to RAM and the network card.
 
Because of this, `shutdown.sh` sends `systemctl suspend` to Sacro instead of `shutdown -h now`. This command also requires passwordless sudo, which must be added explicitly:
 
```bash
echo "seth ALL=(ALL) NOPASSWD: /usr/bin/systemctl suspend" >> /etc/sudoers.d/shutdown
chmod 440 /etc/sudoers.d/shutdown
```
 
The final `/etc/sudoers.d/shutdown` on Sacro should contain both lines:
 
```
seth ALL=(ALL) NOPASSWD: /sbin/shutdown
seth ALL=(ALL) NOPASSWD: /usr/bin/systemctl suspend
```
 
Without the suspend permission, SSH will fail with:
```
sudo: a terminal is required to read the password
```
 
> **Why not use the same approach on all nodes?**
> Suspend keeps ~1-2W of power consumption to maintain RAM and NIC state.
> For nodes that support WOL from full poweroff, `shutdown -h now` is preferred
> since it consumes 0W and is cleaner for a node that may stay off for long periods.
 
---
 
## How WOL Works
 
Magic packets are Layer 2 broadcasts — they travel over Ethernet within the same
broadcast domain (same switch). This means:
 
- All nodes must be connected via **Ethernet cable**, not WiFi
- Sadida must be on the **same switch** as the target node
- The NIC must remain powered after shutdown — this is guaranteed by the BIOS
  on all nodes except Sacro, which requires suspend instead

This is exactly why **Ocra is not a WOL target**: it is the one node
connected over WiFi, not Ethernet, so it is structurally excluded from all
of the above. `shutdown.sh` never powers Ocra off in the first place, and
its entry in `wake.sh`'s node list exists only so the ping-liveness check
has an address to check — that address is Ocra's Tailscale IP, precisely
because its LAN IP (unlike the Ethernet nodes') is not stable.
---
 
## SSH Authentication
 
These scripts use standard SSH with password authentication. No SSH keys are
required, but each node must have the sudoers file configured as described above
so that `sudo shutdown` and `sudo systemctl suspend` do not prompt for a password
over a non-interactive SSH session.
 
The SSH password is **never stored in these scripts**. You will be prompted once
per node when running the scripts interactively.
