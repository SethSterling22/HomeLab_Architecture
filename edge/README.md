# Public Access (No-IP + Caddy)

The one part of this HomeLab that is deliberately reachable from the public
internet. Everything else in this repo is reached over Tailscale or the LAN
on purpose — this directory is the intentional exception, kept small and
separate so it's easy to audit and easy to tear down without touching
anything else.

## Architecture

```
Internet
   │
   └── Your router (port-forward 80, 8443, ... → Ocra's LAN IP)
          │
          └── Ocra (24/7)
                 ├── ddclient  ──updates──▶  No-IP (yourname.ddns.net → your public IP)
                 └── Caddy (:80 ACME, :8443 Nextcloud, ...)
                        └── reverse_proxy ──▶  wake-proxy (100.107.52.17:8093)
                                                    └── Aery's Nextcloud (auto-wake if asleep)
```

Caddy gets and renews a Let's Encrypt certificate for your No-IP hostname
automatically (HTTP-01 challenge over port 80). Every additional service
you expose is just one more Caddy site block sharing that same certificate,
listening on its own port.

## 1. Prerequisites

- A No-IP account with a hostname created (free tier gives you one, e.g.
  `yourname.ddns.net`). Note the hostname, your No-IP username and password.
- Router access to add port-forwarding rules.
- Ocra's **LAN IP** (not its Tailscale IP — port-forwarding happens at the
  router, on the LAN side). Check with `ip a` on Ocra.

## 2. No-IP dynamic DNS (ddclient)

```bash
cd edge
cp .env.example .env
cp ddclient/ddclient.conf.example ddclient/ddclient.conf
$EDITOR .env                       # ACME_EMAIL, NOIP_HOSTNAME
$EDITOR ddclient/ddclient.conf     # login, password, your-hostname.ddns.net
```

`ddclient` checks your public IP every 5 minutes (`daemon=300`) and updates
No-IP only when it changes. No-IP free hostnames also expire after 30 days
of no confirmation — this keeps it alive automatically, so you won't need
to click "confirm" in their web UI every month.

## 3. Router port-forwarding

Forward these to **Ocra's LAN IP**:

| External port | Internal port | Purpose |
| --- | --- | --- |
| 80 | 80 | ACME HTTP-01 challenge only — required for Caddy to get/renew certs. Do not remove this even if you don't expose anything on plain HTTP. |
| 8443 | 8443 | Nextcloud (the example already wired up in Caddyfile) |

Add one more row here (matching a new Caddyfile block) each time you expose
another service. Exact steps depend on your router's UI — look for "Port
Forwarding" or "Virtual Server," and forward TCP for all of these.

## 4. Nextcloud-side configuration (required for the example)

Nextcloud checks the `Host` header against an allowlist. wake-proxy already
rewrites `Host` to Aery's own trusted hostname:port before this ever reaches
Nextcloud (see `monitoring/wake-proxy/wake-proxy.js`), so **no
`trusted_domains` change is needed** for the Host header itself — but
Nextcloud also needs to know it's being reached over HTTPS through a proxy,
otherwise it will generate `http://` links and reject some requests. On
Aery, in Nextcloud's `config/config.php`, add:

```php
'overwriteprotocol' => 'https',
```

## 5. Launch

```bash
cd edge
docker compose up -d
docker compose logs -f caddy      # watch the first certificate issuance
```

## 6. Verify

```bash
curl -I https://<your-hostname>.ddns.net:8443
```

Expect a valid TLS handshake (no cert warning) and a response proxied all
the way through to Nextcloud. If it times out: check the router port-
forward first (most common cause), then `docker compose logs caddy` for
ACME errors (rate limits, port 80 not actually reachable from the internet).

## Adding a new service

1. Copy the template block in `Caddyfile`, fill in the port and the
   backend's **Tailscale IP** (not LAN IP — see the Caddyfile's own header
   comment for why).
2. Add the matching port under `caddy.ports` in `docker-compose.yaml`.
3. Forward that port on your router to Ocra, same as step 3 above.
4. `docker compose up -d --force-recreate caddy`

## Security — read this before exposing anything

Every port forwarded here is reachable by anyone on the internet, not just
you. A few rules this repo follows for that reason:

- **Never expose these through this stack, under any circumstance:**
  Proxmox's web UI or SSH on Sadida (the hypervisor), the k3s API server,
  and the Control API (`monitoring/control-api/`) — that last one can power
  nodes off remotely; it is protected by a bearer token today, but a token
  is not a substitute for simply not putting it on the internet.
- Only expose applications that have their own authentication (Nextcloud
  has a login page). Don't expose Grafana, Portainer, or similar admin
  tools this way unless they sit behind their own strong auth AND you've
  thought through what a compromised credential there would let someone do.
- Consider adding [Crowdsec](https://www.crowdsec.net/) or `fail2ban`
  in front of Caddy if you expose something popular enough to attract
  scanning/brute-force traffic. Not set up here yet — noted as a future
  hardening step, not a blocker to a first, careful exposure.
- Watch `docker compose logs caddy` (or wire its Prometheus metrics into
  the existing `monitoring/` stack — Caddy exposes a `/metrics` endpoint)
  if you want visibility into what's hitting these ports from the internet.

## Layout

```
edge/
├── docker-compose.yaml        # Caddy (reverse proxy + auto TLS) + ddclient (No-IP updater)
├── Caddyfile                  # One site block per exposed port
├── .env.example
└── ddclient/
    └── ddclient.conf.example
```
