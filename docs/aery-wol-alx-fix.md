# Fixing Wake-on-LAN on Aery (alx driver / QCA8171)

## The problem, confirmed

Aery (an Acer Aspire E1-422) uses a Qualcomm Atheros QCA8171 NIC on the
`alx` Linux kernel driver. Testing this session confirmed:

- `ethtool enp1s0f0` reports no `Supports Wake-on` / `Wake-on` lines at all.
- `ethtool -s enp1s0f0 wol g` fails with `netlink error: Operation not
  supported`.
- A real shutdown + WOL round-trip failed, both from a full poweroff
  (`shutdown -h now`) and from suspend (`systemctl suspend`), despite "Wake
  on LAN" being enabled in the BIOS.

This is a **known, long-standing limitation of the mainline `alx` driver**:
WOL support was removed/never implemented for this chip in the upstream
kernel. It is not something the BIOS toggle, `ethtool`, or a systemd config
change can fix. Confirmed via:

- [alx: Wake-on-LAN with Qualcomm Atheros QCA8171 — linux-kernel mailing list](https://www.spinics.net/lists/kernel/msg1957028.html)
- [ubuntu - WOL on Qualcomm Atheros QCA8171 on Linux not working](http://primitattive.blogspot.com/2012/07/ubuntu-wol-on-qualcomm-atheros-qca8171.html)

## The fix: `alx-wol` (DKMS)

[AndiWeiss/alx-wol](https://github.com/AndiWeiss/alx-wol) patches the `alx`
driver to restore WOL support, packaged as a DKMS module so it rebuilds
automatically on kernel updates. Chosen over the alternative
(AMV007/alx_dkms_installer) because it is actively maintained (latest
release 3.1, March 2025) and explicitly tested on **Debian 12 (Bookworm)** —
what Aery runs.

**⚠️ This is third-party, community-maintained kernel code, distributed
"AS IS" with no warranty (the project's own disclaimer).** It is being
installed on the node hosting Nextcloud and shared storage. Read through
this whole runbook before starting, and do it at a time when a brief
network hiccup or a reboot is acceptable.

### Before you start

1. **Note the current kernel**, in case you need to boot back into it:
   ```bash
   uname -r
   ```
   Debian's default `apt` behavior keeps at least one previous kernel
   installed and in the GRUB menu, so a working fallback should already
   exist — but confirm this with:
   ```bash
   ls /boot/vmlinuz-*
   ```
   More than one entry means a fallback is available.

2. **Check Secure Boot status.** An out-of-tree, unsigned kernel module
   like this one will be silently refused at load time if UEFI Secure Boot
   is enforcing signatures:
   ```bash
   mokutil --sb-state 2>/dev/null || echo "mokutil not installed — check in the BIOS/UEFI setup instead"
   ```
   If it reports `SecureBoot enabled`, either disable Secure Boot in the
   BIOS (simplest for a home server) or be prepared to enroll a MOK
   (Machine Owner Key) to sign the module — not covered by this runbook,
   ask if you hit this.

3. **Known issue on kernels older than 6.5** (from the project's own
   README): setting Wake-on to `d` can leave the interface down after a
   suspend/resume cycle. Recoverable with a reboot, or:
   ```bash
   sudo rmmod alx
   sudo insmod $(find /lib/modules/$(uname -r)/ -name 'alx.*' | grep -v /kernel/)
   ```
   Version 3.1 (what we're installing) specifically fixes the related
   "Wake on lan disabled" issue for kernel 6.5+. Check your kernel version
   against this before deciding whether it applies.

### Install

```bash
sudo apt update
sudo apt install -y dkms wget

git clone https://github.com/AndiWeiss/alx-wol.git
cd alx-wol
sudo ./install.sh
```

Watch the output for `#### installation of alx-wol version ... succeeded ####`.
If it fails, the script's own error messages are specific (missing dkms,
missing kernel headers at `/lib/modules/$(uname -r)`, missing gcc) — send me
the exact output and we'll work through it.

### Reboot and re-verify

A reboot ensures the patched module is the one actually loaded (and picked
up by initramfs-tools, which the installer hooks into on Debian):

```bash
sudo reboot
```

After it comes back up:

```bash
sudo ethtool enp1s0f0
```

You should now see `Supports Wake-on: ...g...` and a `Wake-on:` line you can
actually change:

```bash
sudo ethtool -s enp1s0f0 wol g
sudo ethtool enp1s0f0 | grep Wake-on
```

If `Wake-on: g` sticks (not `d`), the driver-level fix worked.

### Make it persistent across reboots

`ethtool -s ... wol g` only lasts until the next boot/link reset unless
something re-applies it. On Debian without NetworkManager, the simplest
persistent fix is a systemd unit:

```bash
sudo tee /etc/systemd/system/wol-enp1s0f0.service <<'EOF'
[Unit]
Description=Enable Wake-on-LAN on enp1s0f0
After=network.target

[Service]
Type=oneshot
ExecStart=/sbin/ethtool -s enp1s0f0 wol g

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now wol-enp1s0f0.service
```

### Final round-trip test

Back to the same test that failed before — from anywhere on the tailnet:

```bash
./scripts/wol/shutdown.sh aery --yes
./scripts/wol/wake.sh aery
```

If this now succeeds, two things need to change back in the repo (ask me,
since I made both changes when the driver-level fix wasn't available yet):

1. `scripts/wol/shutdown.sh` — Aery can move off the `systemctl suspend`
   exemption and back onto the normal `shutdown -h now` path, now that a
   full poweroff can actually wake back up. (Optional — suspend also works
   and draws a little more standby power; full poweroff saves more. Your
   call.)
2. Only then set `CONTROL_API_ALLOW_SHUTDOWN_AERY=true` in `monitoring/.env`
   and consider adding `aery` to `IDLE_SHUTDOWN_NODES`.

### If it still doesn't work

Send me:
```bash
dkms status
sudo ethtool -i enp1s0f0
sudo journalctl -b | grep -i alx
```
and we'll look at whether the patch applied cleanly against this specific
kernel version, or whether Secure Boot is silently blocking the module load.
