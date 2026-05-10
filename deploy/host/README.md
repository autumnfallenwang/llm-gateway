# Host setup — Ollama LAN bind

The k3s pod can only reach the host Ollama if Ollama listens on `0.0.0.0:11434`
instead of the default `127.0.0.1:11434`. This drop-in conf does that without
modifying the upstream-managed `ollama.service` unit file.

## Install

```sh
sudo install -d -m 755 /etc/systemd/system/ollama.service.d
sudo install -m 644 deploy/host/ollama-override.conf \
  /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

The brief restart drops in-flight Ollama requests; expected window ~2s on this
host (cold model loads excepted). The compose-managed `llm-gateway` container
keeps working because `localhost:11434` is part of `0.0.0.0:11434`.

## Verify

```sh
# Host-side
ss -tlnp | grep 11434
# Expect: LISTEN ... *:11434 ... (NOT 127.0.0.1:11434)

# From inside the cluster (any namespace will do)
kubectl run -it --rm test-ollama --image=alpine --restart=Never -- \
  wget -qO- http://192.168.1.163:11434/api/tags
# Expect: a JSON list of installed models
```

## Rollback

```sh
sudo rm /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
ss -tlnp | grep 11434     # back to 127.0.0.1:11434
```

## Security note

After this change, every device on the LAN (`192.168.1.0/24`) can hit
`http://192.168.1.163:11434/`. Acceptable on a single-user home network; would
need firewalling on a shared/work LAN. The locked migration plan accepts this
trade-off in §2 — `docs/k3s-migration/02-K3S_REFERENCE.md` records "No firewall
(firewalld/ufw/iptables all inactive)" as the host's current posture.
