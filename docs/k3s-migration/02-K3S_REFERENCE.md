# k3s System — Reference Notes

Comprehensive picture of the home k3s setup: architecture, what's deployed, conventions, and how to operate it. Use as a reference while migrating apps in.

## High-level architecture

```
┌──────────────────────── GitHub ────────────────────────┐
│                                                        │
│  arch-infra (monorepo, single source of truth)         │
│   ├─ bootstrap/argocd/   vendored Argo CD install      │
│   ├─ bootstrap/root-app  app-of-apps entry point       │
│   ├─ infra/              cluster foundations           │
│   ├─ platform/           loki, grafana, alloy, ...     │
│   └─ apps/               Argo CD Application CRs       │
│                                                        │
│  llm-gateway / homecal / homenews / ...                │
│   ├─ src + Dockerfile                                  │
│   ├─ deploy/chart/       Helm chart per app            │
│   └─ .github/workflows/  build + push + bump tag       │
│                                                        │
│  ghcr.io/autumnfallenwang/<app>                        │
└────────────────────────┬───────────────────────────────┘
                         │  outbound HTTPS (NAT-friendly)
                         ▼
┌──────────────────── Arch box (k3s) ────────────────────┐
│                                                        │
│  Argo CD ──► watches arch-infra                        │
│         ──► applies manifests                          │
│         ──► pulls images from ghcr.io                  │
│                                                        │
│  Traefik (bundled) ──► routes *.arch.local by host     │
│                                                        │
│  Namespaces:                                           │
│    argocd / observability / llmgw / homecal / homenews │
└────────────────────────────────────────────────────────┘
```

## Host

- Machine: `aaron-desktop-arch`
- LAN IP: `192.168.1.163`
- OS: Arch Linux, kernel 7.0.3-arch1-2
- Hardware: i7-11700K (16 threads), 64GB RAM, RTX 3090, 1.8TB NVMe (1.2TB free)
- No firewall (firewalld/ufw/iptables all inactive)
- Ollama runs natively (port 11434) — currently bound to 127.0.0.1, will rebind to 0.0.0.0 during llmgw migration

## k3s itself

- Version: `v1.35.4+k3s1`
- Install: official curl installer, systemd unit `k3s.service` (enabled)
- Binary: `/usr/local/bin/k3s`
- Storage: `/var/lib/rancher/k3s/storage/` (local-path-provisioner)
- Kubeconfig: `~/.kube/config` (mode 600)
- Bundled components: containerd, flannel CNI, Traefik (Ingress), local-path-provisioner, klipper-lb, metrics-server, CoreDNS

## Repos

- **arch-infra** — `https://github.com/autumnfallenwang/arch-infra` (public)
  - Cluster source of truth. ArgoCD watches `apps/` recursively.
- **app repos** — each app has its own repo (`autumnfallenwang/llm-gateway`, etc.). Helm chart lives at `deploy/chart/` in each.
- **Container registry** — `ghcr.io/autumnfallenwang/<app>`, public, free.

## arch-infra layout

```
arch-infra/
├── bootstrap/
│   ├── argocd/                       # vendored Argo CD install (applied by hand once)
│   │   ├── install.yaml              # snapshot from upstream stable
│   │   ├── namespace.yaml
│   │   ├── kustomization.yaml
│   │   ├── ingress.yaml              # argocd.arch.local
│   │   ├── patches/cmd-params.yaml   # server.insecure: "true"
│   │   └── README.md
│   └── root-app.yaml                 # ArgoCD root Application → apps/
├── infra/                            # (empty, future: sealed-secrets, cert-manager)
├── platform/
│   └── observability/
│       ├── loki/values.yaml
│       ├── grafana/values.yaml
│       └── alloy/values.yaml
└── apps/
    ├── observability-loki.yaml       # Application CRs (each ~25 lines)
    ├── observability-grafana.yaml
    └── observability-alloy.yaml
```

## What's currently running

| Namespace | Component | Purpose | Access |
|---|---|---|---|
| argocd | Argo CD | GitOps CD | http://argocd.arch.local |
| observability | Loki | Log store | http://loki.arch.local (HTTP API) |
| observability | Grafana | UI for logs/metrics | http://grafana.arch.local |
| observability | Alloy (DaemonSet) | Log shipper, scrapes all pod logs | (no UI) |
| kube-system | Traefik | Ingress controller | host :80 / :443 (LoadBalancer) |
| kube-system | CoreDNS, metrics-server, local-path, klipper-lb | k3s built-ins | — |

### Loki retention policy

- Default: 14 days
- `kube-system`, `argocd`, `observability` namespaces: 3 days
- `llmgw`, `homecal`, `homenews` (when they exist): 30 days

### Argo CD Application chain

```
root-app.yaml (applied by hand once)
  └── watches arch-infra/apps/ recursively
        ├── observability-loki   → grafana/loki Helm chart 6.24.0
        ├── observability-grafana → grafana/grafana Helm chart 8.5.0
        └── observability-alloy   → grafana/alloy Helm chart 0.10.0
```

## Conventions (decisions to keep applying)

### Networking

- **Each app gets its own hostname.** No more port-as-identity.
- **External (LAN/browser):** `https://<app>.arch.local` (Traefik on :80/:443).
- **Internal (pod-to-pod):** `http://<svc>.<ns>` — Service exposes :80, no port in URL.
- **Container's actual port** lives in `targetPort` of the Service. Implementation detail.
- **Service shape:** `port: 80`, `targetPort: <native>`.
- **Hostname resolution:** `/etc/hosts` today (Arch box and Mac). dnsmasq for LAN-wide once it gets tedious.

### Platform vs app responsibility

| Platform (one shared deployment in `platform/`) | App-owned (per app, in its namespace) |
|---|---|
| Logging — Loki | Databases (Postgres, SQLite) |
| Dashboards — Grafana | Caches |
| Log shipper — Alloy | Queues, app-specific state |
| Ingress controller — Traefik | |

Criterion: *"do all apps consume this the same way?"* — yes → platform; no → app-owned. DBs are app-owned even when shape repeats (different schemas, versions, extensions).

### Storage

- **`hostPath` (RO):** for live views of host-managed files (e.g., `.claude` credentials that auto-refresh).
- **PVC (`local-path`):** for app state owned by the cluster (SQLite, Postgres data, Grafana settings, Loki chunks). Lives in `/var/lib/rancher/k3s/storage/`.
- **`emptyDir`:** for pod-only ephemeral scratch.

### Image pipeline

- App repo → GHA (test, build, push to `ghcr.io`, bump tag in `arch-infra`).
- arch-infra commit → Argo CD detects within ~3 min → applies → kubelet pulls image → rolling update.
- **No webhook** GHA → Argo CD. The git commit *is* the trigger. Pull-based, NAT-friendly.

### Secrets

- Plaintext values.yaml for non-sensitive config.
- Sealed Secrets to be installed when first DB password / API key needs to live in git.
- `hostPath` for credentials that auto-refresh on the host (Claude/Codex CLI).

## Common operations

### Access

```bash
# Argo CD UI
http://argocd.arch.local                     # admin / <your reset password>

# Grafana UI (Loki Explore for logs)
http://grafana.arch.local                    # admin / g12jaCS8nuRJFTf1f8KMefk4uRKfDpz3J97ulYBO (reset)

# Loki HTTP API (curl-friendly)
curl -sG http://loki.arch.local/loki/api/v1/query_range \
  --data-urlencode 'query={namespace="argocd"}' \
  --data-urlencode "start=$(date -u -d '-10 min' +%s)000000000" \
  --data-urlencode "end=$(date -u +%s)000000000" \
  --data-urlencode 'limit=20' | jq .
```

### Force Argo CD to re-sync now (skip 3-min poll)

```bash
kubectl annotate app <name> -n argocd argocd.argoproj.io/refresh=normal --overwrite
# or:
kubectl annotate app <name> -n argocd argocd.argoproj.io/refresh=hard --overwrite
```

### Trigger a rolling restart of a deployment

```bash
kubectl rollout restart deployment/<name> -n <namespace>
```

### Inspect a PVC's actual files on disk

```bash
kubectl get pvc -A
sudo ls /var/lib/rancher/k3s/storage/   # find your PVC's directory
```

### Check what's listening on host port 80/443

```bash
kubectl -n kube-system get svc traefik   # EXTERNAL-IP should be 192.168.1.163
ss -tlnp | grep -E ':80 |:443 '          # may not show — klipper-lb uses iptables NAT
```

## Build sequence (status)

1. ✅ Create `arch-infra` repo
2. ✅ Install k3s
3. ✅ Install Argo CD (vendored manifests in arch-infra)
4. ✅ Argo CD Ingress (argocd.arch.local)
5. ✅ App-of-apps root
6. ✅ Observability stack (Loki + Grafana + Alloy)
7. ⏳ **Migrate llmgw** (in progress — next)
8. ⬜ Install Sealed Secrets (when first DB password needed)
9. ⬜ Migrate homecal (Postgres + API + web)
10. ⬜ Migrate homenews (pgvector Postgres + API + web)

## App migration shape (how each app gets brought in)

For every app, the work is:

1. **In app repo**:
   - Add Helm chart at `deploy/chart/`
   - Update Dockerfile (USER directive, etc.)
   - Add `.github/workflows/build.yml` (test → build → push → bump arch-infra)
   - Adjust code if needed (DB connection strings, OLLAMA_BASE_URL, etc.)

2. **In arch-infra**:
   - Add `apps/<app>.yaml` Argo CD Application CR pointing at the app repo's `deploy/chart`

3. **Cutover**:
   - Push commits, wait for GHA + Argo CD
   - Add hostname to `/etc/hosts`
   - Smoke test
   - Stop the old docker compose version
