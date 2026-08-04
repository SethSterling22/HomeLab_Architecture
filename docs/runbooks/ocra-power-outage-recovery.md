# Runbook — Ocra Post-Outage Connectivity (Hermes ECONNREFUSED)

## Symptom

After a power outage (or any full reboot of Ocra), n8n workflow executions fail
on any HTTP Request node calling Hermes:

```
The service refused the connection - perhaps it is offline
ECONNREFUSED 127.0.0.1:8080
```

This happens even though `docker ps` shows all containers `Up` and Hermes's own
logs say `Hermes HTTP gateway listening on :8080`.

## Root cause

`hermes-gateway` and `n8n` both use `network_mode: service:tailscale` — they
share the network namespace of the `tailscale` sidecar container instead of
having their own. On a cold start (e.g. right after the host comes back from a
power outage and Docker auto-starts everything), there's a **race**: if
`hermes-gateway` starts *before* the `tailscale` container is up, it attaches to
the wrong/stale network namespace. Hermes still runs and listens on `:8080`
fine from its own point of view, but `n8n` (which usually starts a bit later,
once `tailscale` is already up) ends up in the *correct* namespace — so the two
can no longer see each other over `127.0.0.1`, even though both look healthy.

This has been observed as a recurring pattern after outages roughly every
1–2 weeks, matching the compose stack's restart history.

## Fast diagnosis

```bash
# 1. Are all four containers up?
sudo docker ps

# 2. Does Hermes actually respond, tested from inside n8n's own container?
sudo docker exec n8n_core wget -qO- http://127.0.0.1:8080/health

# 3. If step 2 fails, compare start times — hermes should NOT start before tailscale
sudo docker inspect hermes_gateway --format '{{.State.StartedAt}}'
sudo docker inspect n8n_tailscale  --format '{{.State.StartedAt}}'
sudo docker inspect n8n_core       --format '{{.State.StartedAt}}'
```

If `hermes_gateway`'s `StartedAt` is earlier than `n8n_tailscale`'s, that
confirms the race described above.

## Immediate fix

```bash
cd ~/Productivity_Tools/n8n   # wherever the compose file currently lives
sudo docker compose restart hermes-gateway

# verify
sudo docker exec n8n_core wget -qO- http://127.0.0.1:8080/health
```

Restarting `hermes-gateway` alone is enough as long as `tailscale` is already
stable (it almost always is, since it tends to come up quickly). No need to
restart `n8n` unless the health check above still fails after the
`hermes-gateway` restart.

After the fix, trigger a **brand-new** Telegram message to confirm — don't rely
on the old failed execution still shown in n8n's history, it won't update
itself.

## Long-term fix (not yet applied — lives in `Productivity_Tools/n8n/docker-compose.yaml`)

Add an explicit dependency so `hermes-gateway` can't win the startup race
again:

```yaml
hermes-gateway:
  depends_on:
    tailscale:
      condition: service_started   # or service_healthy if a healthcheck is added
```

A more robust (bigger) fix is to stop sharing the Tailscale sidecar's network
namespace for internal traffic altogether: put `n8n` and `hermes-gateway` on
their own Docker bridge network and call Hermes by service name
(`http://hermes-gateway:8080`) instead of `127.0.0.1`. That removes this whole
class of bug, since internal service-to-service traffic no longer depends on
the sidecar's lifecycle. This change belongs to whoever owns
`docker-compose.yaml` (the automation side, per the HomeLab/Productivity split).

## Related

Once the monitoring stack (see `docs/monitoring-stack-plan.md`) is in place,
this exact failure — a service that's "up" per Docker but not actually
reachable — is exactly what a Prometheus blackbox/health-check alert on
`hermes_gateway:8080` would catch immediately, instead of finding out from a
failed n8n execution.
