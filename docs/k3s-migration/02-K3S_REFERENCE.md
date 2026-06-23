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
| llmgw | LLM Gateway | OpenAI-compatible API → Ollama/Anthropic (Codex gated, Gemini dropped) | http://llmgw.arch.local |

### Loki retention policy

- Default: 14 days
- `kube-system`, `argocd`, `observability` namespaces: 3 days
- `llmgw`, `homecal`, `homenews` (when they exist): 30 days

### Argo CD Application chain

```
root-app.yaml (applied by hand once)
  └── watches arch-infra/apps/ recursively
        ├── observability-loki    → grafana/loki Helm chart 6.24.0
        ├── observability-grafana → grafana/grafana Helm chart 8.5.0
        ├── observability-alloy   → grafana/alloy Helm chart 0.10.0
        └── llmgw                 → autumnfallenwang/llm-gateway deploy/chart (single-source)
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
7. ✅ Migrate llmgw (2026-05-10 → 2026-05-11; full GitOps loop verified)
8. ⬜ Install Sealed Secrets (when first DB password needed — likely with homecal)
9. ⬜ Migrate homecal (Postgres + API + web)
10. ⬜ Migrate homenews (pgvector Postgres + API + web)

## App migration shape (how each app gets brought in)

Concrete playbook — phrased as a checklist you can copy. Validated end-to-end on the llmgw migration (2026-05-10 → 2026-05-11). Skip steps that don't apply (e.g., host bind for non-Ollama apps).

### Phase A — App repo prep (in the app's own repo)

1. **State layer** — if the app currently writes loose JSON files anywhere, replace with SQLite (`better-sqlite3@^12`) so the pod can own its persistence on a single PVC. See `llm-gateway/src/lib/db.ts` for the pattern (openDb/getDb/setDb singleton + table accessors + WAL journal).
2. **Dockerfile hardening** — `USER node` (UID 1000), pair native build deps in a transient `apk add --virtual .build … && … && apk del .build` so they don't bloat the final image layer. Pattern: `llm-gateway/deploy/Dockerfile`.
3. **Helm chart at `deploy/chart/`** — `Chart.yaml` + `values.yaml` + `.helmignore` + templates: `_helpers.tpl`, `deployment.yaml`, `service.yaml`, `ingress.yaml`, `pvc.yaml` (if needed), `NOTES.txt`. Single replica + `strategy: Recreate` if the app has stateful storage. Pattern: `llm-gateway/deploy/chart/`.
4. **GHA workflow at `.github/workflows/build.yml`** — `test` job (lint + `test:fast` only; CI has no live external deps) on PR + main; `build-and-deploy` job on main only pushes the image to GHCR and bumps `arch-infra/apps/<app>.yaml` via `yq` (not `sed` — too greedy). Pattern: `llm-gateway/.github/workflows/build.yml`.
5. **Dependabot at `.github/dependabot.yml`** — weekly PRs for `npm` + `docker` + `github-actions` ecosystems. Group SDK deps that ship new capabilities (e.g., pi-ai for llmgw). Pattern: `llm-gateway/.github/dependabot.yml`.
6. **Code touchups** — adjust env var defaults so the chart wires upstream services correctly (the pod talks to its DB / Ollama / external service at a specific URL). For llmgw: `OLLAMA_BASE_URL` switched from `localhost` to the host LAN IP.

### Phase B — Host-side prep (only if the app needs to reach a host service)

For each host-resident dependency the pod needs:
- Drop a systemd override at `deploy/host/<service>-override.conf` + README runbook (install / verify / rollback / security note).
- Operator runs `sudo install -d -m 755 … && sudo install -m 644 … && sudo systemctl daemon-reload && sudo systemctl restart <unit>`.
- Verify with `ss -tlnp | grep <port>` (expect `*:<port>`, not `127.0.0.1:<port>`) and an in-cluster `kubectl run --rm test --image=alpine -- wget -qO- http://<host-ip>:<port>/<probe>`.
- Pattern: `llm-gateway/deploy/host/`.

### Phase C — GitHub setup (manual, owner-only, one-time per app)

1. Create fine-grained PAT `ARCH_INFRA_TOKEN` (Settings → Developer settings → PATs → fine-grained):
   - Resource owner: `autumnfallenwang`
   - Repository access: **Only select** → `arch-infra`
   - Permissions → Contents: **Read and write**
   - Expiration: 1 year (max, no "never" option)
2. Add as repo secret in the app repo: Settings → Secrets and variables → Actions → New repository secret → `ARCH_INFRA_TOKEN`.
3. First push to `main` builds and pushes the image to GHCR. **The first push creates the GHCR package as private by default** — k3s can't pull it. After the first successful build:
   - Visit `https://github.com/users/autumnfallenwang/packages/container/<app>/settings`
   - Danger zone → Change visibility → Public
   - Manage Actions access → add the app repo with Write role

### Phase D — arch-infra registration

1. Create `~/github/arch-infra/apps/<app>.yaml` as a single-source `Application` CR pointing at the app repo's `deploy/chart`. Includes `spec.source.helm.parameters: [{ name: image.tag, value: "latest" }]` — this is the field GHA's `yq` rewrites on every build. Pattern: `~/github/arch-infra/apps/llmgw.yaml`.
2. `kubectl apply --dry-run=client -f ~/github/arch-infra/apps/<app>.yaml` to validate before committing.
3. **Don't push to arch-infra until** Phase C is done AND the GHA workflow has produced at least one image — otherwise the first sync will `ImagePullBackOff` on a non-existent package.

### Phase E — Cutover

1. `git push origin main` in the app repo. Watch GHA go green (~2 min for test + build + arch-infra bump).
2. `git -C ~/github/arch-infra fetch origin main && git -C ~/github/arch-infra log -1 apps/<app>.yaml` to confirm the bump landed.
3. `kubectl annotate app root -n argocd argocd.argoproj.io/refresh=normal --overwrite` to skip the 3-min poll.
4. Watch the pod come up: `kubectl get pod -n <app> -w`. First sync creates namespace + PVC + Service + Deployment + Ingress in one shot.
5. Add `192.168.1.163 <app>.arch.local` to `/etc/hosts` on the dev box.
6. Smoke test:
   - Health: `curl -fsS http://<app>.arch.local/`
   - Whatever the app's `/v1/models`-equivalent surface is
   - Real end-to-end request through the Ingress
   - `kubectl logs -n <app> deploy/<app>` for boot log sanity
   - Loki: `curl -sG http://loki.arch.local/loki/api/v1/query_range --data-urlencode 'query={namespace="<app>"} | json' --data-urlencode "start=$(date -u -d '-5 min' +%s)000000000" --data-urlencode "end=$(date -u +%s)000000000"`
7. Stop the legacy deploy (docker compose down, etc.); confirm host ports freed.
8. Retain the legacy `deploy/compose.yaml` (or equivalent) for ≥2-3 days as a rollback option before deleting.

## Migration gotchas (learned the hard way on llmgw)

1. **ArgoCD excludes both `v1/Endpoints` and `discovery.k8s.io/EndpointSlice`** from sync, cluster-wide, by default (UI-clutter reduction in `argocd-cm`). A manual selectorless `Service` + `Endpoints`/`EndpointSlice` redirection to an external IP **silently drops on sync** — the Service exists but routes nowhere. `kubectl describe app <name>` shows `Message: Resource discovery.k8s.io/EndpointSlice <name> is excluded in the settings`, but the overall status still reads `Synced + Healthy`. **Workarounds:** (a) put the host IP directly in `OLLAMA_BASE_URL`-style env var (what llmgw does — single-host cluster, the indirection is cosmetic anyway); (b) `Service` of `type: ExternalName` for DNS-resolved targets; (c) edit `argocd-cm` to remove the exclusion (cluster-wide change, only if multiple apps need it).
2. **GHA `gh repo clone` doesn't bake the PAT into the push URL.** Local commit succeeds; `git push` fails with `could not read Username for 'https://github.com'`. **Use `git clone https://x-access-token:${GH_TOKEN}@github.com/<owner>/<repo>.git` instead.** Same applies to any GHA step that needs to push to a different repo.
3. **`sed -i 's|tag: .*|tag: <sha>|'` is too greedy.** It matches any line with `tag:`. **Use `yq -i '(.spec.source.helm.parameters[] | select(.name == "image.tag") | .value) = strenv(SHA)' apps/<app>.yaml`** — targets exactly `image.tag.value` and is whitespace/quote tolerant. `yq` (mike farah's v4) is preinstalled on `ubuntu-latest`.
4. **`securityContext` field placement.** `allowPrivilegeEscalation`, `readOnlyRootFilesystem`, `capabilities` are **container-level only**. K8s silently drops them at pod level. Split into `podSecurityContext` (`runAsNonRoot/runAsUser/runAsGroup/fsGroup`) and `containerSecurityContext` (`allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`). Pattern: `llm-gateway/deploy/chart/values.yaml` + `templates/deployment.yaml`.
5. **OAuth credentials persist across pod rolls via PVC** — that's the design — but lazy-refresh paths must be wired into **all** execution paths, not just user-facing endpoints. llmgw had `ensureAnthropicFresh()` only in the chat-completions route handler; `/v1/models/validate` bypassed it and reported 0/22 Anthropic models after the chain expired. Audit every place that uses the cached `apiKey` and ensure the refresh fires before the call.
6. **Recreate strategy, not RollingUpdate**, for any app with a `ReadWriteOnce` PVC + on-disk state (SQLite WAL, etc.). RollingUpdate would briefly run two pods racing on the same volume.
7. **GHCR package privacy is the default** on first push. Until you flip it to public, ArgoCD's `kubectl pull` fails with `ImagePullBackOff` and no imagePullSecret. Phase 0.3 in the migration plan handles this — but it's *manual* and easy to forget.
8. **Docker image size**: native-module-heavy images (e.g., `better-sqlite3`) leave compile intermediates in `node_modules/*/build/Release/obj.target/` — adds ~330MB. A multi-stage build (`FROM node:22-alpine AS builder` → install + compile → `FROM node:22-alpine` → `COPY --from=builder` only the runtime artifacts) reclaims most of it. Out of scope for first cut, worth doing later.
9. **`kubectl logs` and Loki are not redundant** — they have different roles. `kubectl logs` is the dev backstop (real-time tail, current pod only, history bounded by kubelet rotation). Loki is the production surface for everything else: filter by `event/level/req_id`, group by `status`, percentile latency, error rates. Make sure the app emits structured JSON-per-line (pino in llmgw) so LogQL queries like `{namespace="<app>"} | json | event="http.request" | latency_ms > 1000` are useful out of the box.

## Per-app reference: llmgw

A working example to pattern the next app after. All paths/commands real and live.

**Repos:**
- App: `github.com/autumnfallenwang/llm-gateway` (local at `~/agentic/llm-gateway`)
- GitOps: `github.com/autumnfallenwang/arch-infra` → `apps/llmgw.yaml` (local at `~/github/arch-infra`)
- Image: `ghcr.io/autumnfallenwang/llm-gateway:<sha>` (public)

**Network surface:**
- External (LAN/Mac): `http://llmgw.arch.local/` (Traefik) — add `192.168.1.163 llmgw.arch.local` to `/etc/hosts` on each client
- Internal (other namespaces): `http://llmgw.llmgw/` (Service `llmgw` port 80 → targetPort 51277)
- Swagger UI: `http://llmgw.arch.local/docs`

**Cluster shape (rendered from `deploy/chart/`):**
- Namespace: `llmgw`
- Deployment: `llmgw` (1 replica, `Recreate` strategy, UID 1000)
- Service: `llmgw` (ClusterIP, port 80 → targetPort 51277)
- Ingress: `llmgw` (Traefik, host `llmgw.arch.local`)
- PVC: `llmgw-data` (1Gi `local-path`, mount `/home/node/.llm-gateway`, holds `state.db` SQLite)
- hostPath RO mounts: `~/.claude` → `/home/node/host-claude`, `~/.codex` → `/home/node/host-codex`

**Files to study when migrating the next app:**
- Chart: `~/agentic/llm-gateway/deploy/chart/{Chart.yaml,values.yaml,templates/*}`
- Dockerfile: `~/agentic/llm-gateway/deploy/Dockerfile` (native-module build deps + USER node)
- GHA: `~/agentic/llm-gateway/.github/workflows/build.yml`
- Dependabot: `~/agentic/llm-gateway/.github/dependabot.yml`
- Host service runbook: `~/agentic/llm-gateway/deploy/host/`
- Application CR: `~/github/arch-infra/apps/llmgw.yaml`
- Migration retrospective: `~/agentic/llm-gateway/docs/progress.md` Phase 8 + post-Phase-8 cleanup section

**Common ops (substitute `<app>` and namespace for any app):**

```bash
# Tail logs (one pod, current)
kubectl logs -n llmgw deploy/llmgw -f

# Loki history (all pods across rolls, 30d retention)
curl -sG http://loki.arch.local/loki/api/v1/query_range \
  --data-urlencode 'query={namespace="llmgw"} | json | event="http.request"' \
  --data-urlencode "start=$(date -u -d '-30 min' +%s)000000000" \
  --data-urlencode "end=$(date -u +%s)000000000"

# Force restart (e.g., to pick up a host file change without a new image)
kubectl rollout restart deploy/llmgw -n llmgw

# Force ArgoCD to re-sync immediately (skip the 3-min poll)
kubectl annotate app llmgw -n argocd argocd.argoproj.io/refresh=normal --overwrite

# Manually trigger a CI rebuild (no code change needed)
gh workflow run build.yml --repo autumnfallenwang/llm-gateway

# App-specific: re-run model validation
curl -X POST http://llmgw.arch.local/v1/models/validate

# Inspect on-disk state (SQLite + WAL)
kubectl exec -n llmgw deploy/llmgw -- ls -la /home/node/.llm-gateway/
```

**End-to-end deploy timeline** (push → live, observed):
- t+0:00 `git push origin main`
- t+0:02 GHA `test` (lint + test:fast, ~60s) and `build-and-deploy` (BuildKit + GHA cache → GHCR + arch-infra bump, ~2 min) start
- t+0:05 arch-infra has the bump commit; ArgoCD's next poll picks it up
- t+0:05–0:08 ArgoCD syncs (3-min interval, or instant if you `refresh=normal` the root or app)
- t+0:08 Pod rolls (`Recreate`: old pod terminates, new pod starts; ~10-30s downtime)
- t+0:09 New pod serves traffic, registry rebuilt, Loki sees `server.start` event within ~2s
