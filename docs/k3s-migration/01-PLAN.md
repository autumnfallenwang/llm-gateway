# llmgw — k3s Migration Plan (detailed)

Source of truth for the actual migration work. Each phase has concrete steps, files, and acceptance criteria.

## Target architecture

```
GitHub:
  autumnfallenwang/llm-gateway     (this repo)
    ├── src/                       (existing)
    ├── deploy/chart/              (NEW: Helm chart)
    ├── deploy/Dockerfile          (modified: USER node, EXPOSE drop, etc.)
    ├── .github/workflows/         (NEW: build.yml)
    └── deploy/llmgw, compose.yaml (DELETED after cutover)

  autumnfallenwang/arch-infra
    └── apps/llmgw.yaml            (NEW: ArgoCD Application + Ollama Service/Endpoints)

GHCR:
  ghcr.io/autumnfallenwang/llm-gateway:<sha>

k3s cluster (arch-desktop-arch, 192.168.1.163):
  namespace: llmgw
    ├── Deployment llmgw           (1 replica, image from GHCR)
    ├── Service llmgw              (port 80 → targetPort 51277)
    ├── Service ollama             (port 11434, no selector)
    ├── Endpoints ollama           (manual: 192.168.1.163:11434)
    ├── PVC llmgw-data             (1Gi local-path, SQLite + cache)
    └── Ingress llmgw              (host: llmgw.arch.local)
```

## Phase 0 — One-time GitHub setup (do before Phase 1 PR merges)

### 0.1 Create `ARCH_INFRA_TOKEN` PAT

GHA needs to commit to `arch-infra` (a different repo than the one running the workflow), which `GITHUB_TOKEN` can't do.

1. GitHub → Settings → Developer settings → **Personal access tokens (fine-grained)** → Generate new token.
2. Resource owner: `autumnfallenwang`.
3. Repository access: **Only select repositories** → pick `arch-infra`.
4. Permissions → Repository permissions → **Contents: Read and write**.
5. Generate, copy the token (shown once).

### 0.2 Add the PAT as a repo secret

1. In `llm-gateway` repo → Settings → Secrets and variables → Actions → **New repository secret**.
2. Name: `ARCH_INFRA_TOKEN`.
3. Value: paste the PAT.

### 0.3 (After first GHA run) — flip GHCR package to public

The first push to `ghcr.io` creates a **private** package by default, even if the repo is public. k3s would fail to pull without credentials.

1. Wait for first GHA workflow to complete successfully (Phase 1 merged to main).
2. Visit `https://github.com/users/autumnfallenwang/packages/container/llm-gateway/settings`.
3. Scroll to **Danger zone** → **Change visibility** → set to **Public**.
4. Same page → **Manage Actions access** → add repo `llm-gateway` with **Write** role (so future workflow pushes are tied to the repo).

### Checklist

- [ ] PAT `ARCH_INFRA_TOKEN` created with `Contents: write` on `arch-infra` only
- [ ] Secret `ARCH_INFRA_TOKEN` added to `llm-gateway` repo
- [ ] GHCR package `llm-gateway` flipped to public (after first push)
- [ ] GHCR package linked to `llm-gateway` repo with Write role

## Phase 1 — App repo: code + chart + CI

### 1.1 Replace JSON file storage with SQLite

- Add `better-sqlite3` to dependencies.
- Create `src/lib/db.ts`:
  - Opens `/home/node/.llm-gateway/state.db` (env: `LLMGW_DB_PATH`).
  - Runs migrations on startup (CREATE TABLE IF NOT EXISTS).
  - Two tables:
    - `credentials_chain` (provider TEXT PK, payload TEXT, updated_at INT)
    - `model_validation` (model TEXT PK, status TEXT, latency_ms INT, error TEXT, validated_at INT)
- Refactor `src/services/auth.ts`:
  - Replace `readFileSync(ANTHROPIC_CACHE_PATH)` / `writeFileSync` with DB queries.
  - Keep `ANTHROPIC_SEED_PATH` (still hostPath RO).
- Refactor `/v1/models/validate` handler:
  - Replace JSON file read/write with DB upsert.
- Drop `ANTHROPIC_CACHE_PATH` and `VALIDATION_FILE_PATH` env vars (or keep as compat aliases pointing into DB).

**Acceptance:** existing tests pass with DB-backed implementation; new unit tests for DB layer.

### 1.2 Dockerfile changes

```dockerfile
FROM node:22-alpine

# Install build deps for better-sqlite3 native module
RUN apk add --no-cache --virtual .build python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && apk del .build

COPY tsconfig.json ./
COPY src/ src/

USER node
CMD ["npm", "start"]
```

Notes:
- Build deps are needed because `better-sqlite3` compiles native bindings; deleted in same RUN to keep image small.
- `USER node` drops to UID 1000 (built into base image).
- No `EXPOSE` directive — Service's `targetPort` handles it.

**Acceptance:** image builds, container runs as UID 1000 (`docker run --rm IMAGE id`).

### 1.3 Helm chart at `deploy/chart/`

```
deploy/chart/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── _helpers.tpl
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── pvc.yaml
    └── NOTES.txt
```

**values.yaml (skeleton):**
```yaml
image:
  repository: ghcr.io/autumnfallenwang/llm-gateway
  tag: latest
  pullPolicy: IfNotPresent

replicaCount: 1

service:
  port: 80
  targetPort: 51277

ingress:
  enabled: true
  className: traefik
  host: llmgw.arch.local

persistence:
  enabled: true
  size: 1Gi
  storageClass: local-path
  mountPath: /home/node/.llm-gateway

env:
  LLM_GATEWAY_PORT: "51277"
  OLLAMA_BASE_URL: http://ollama.llmgw:11434
  ANTHROPIC_SEED_PATH: /home/node/host-claude/.credentials.json
  CODEX_CREDENTIALS_PATH: /home/node/host-codex/auth.json
  LLMGW_DB_PATH: /home/node/.llm-gateway/state.db

hostMounts:
  claude:
    enabled: true
    hostPath: /home/aaronwang/.claude
    mountPath: /home/node/host-claude
  codex:
    enabled: true
    hostPath: /home/aaronwang/.codex
    mountPath: /home/node/host-codex

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    memory: 512Mi

securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  allowPrivilegeEscalation: false

probes:
  liveness:
    httpGet: { path: /, port: 51277 }
    initialDelaySeconds: 10
    periodSeconds: 30
  readiness:
    httpGet: { path: /, port: 51277 }
    initialDelaySeconds: 3
    periodSeconds: 10
```

**Acceptance:** `helm template deploy/chart/` renders without error; `helm lint` passes.

### 1.4 GitHub Actions workflow

`.github/workflows/build.yml`:

```yaml
name: build
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm test

  build-and-deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: .
          file: deploy/Dockerfile
          push: true
          tags: |
            ghcr.io/autumnfallenwang/llm-gateway:latest
            ghcr.io/autumnfallenwang/llm-gateway:${{ github.sha }}

      - name: Bump tag in arch-infra
        env:
          GH_TOKEN: ${{ secrets.ARCH_INFRA_TOKEN }}   # PAT with repo:write on arch-infra
        run: |
          gh repo clone autumnfallenwang/arch-infra /tmp/arch-infra
          cd /tmp/arch-infra
          # Update apps/llmgw.yaml (or values file) with new SHA
          sed -i "s|tag: .*|tag: ${{ github.sha }}|" apps/llmgw.yaml
          git config user.email "actions@github.com"
          git config user.name  "GitHub Actions"
          git add -A
          git commit -m "llmgw: bump to ${{ github.sha }}"
          git push
```

**Required secret:** `ARCH_INFRA_TOKEN` — GitHub fine-grained PAT scoped to `arch-infra` with `Contents: write`. Create once, store in this repo's Actions secrets.

**Acceptance:** PR runs tests; merge to main pushes image to GHCR and bumps `arch-infra/apps/llmgw.yaml`.

### 1.5 Retire `deploy/llmgw` shell wrapper

After successful cutover, delete:
- `deploy/llmgw`
- `deploy/compose.yaml`
- (keep `deploy/Dockerfile` — still used by GHA)

Optionally add a tiny `deploy/k3s.sh` with helpful kubectl shortcuts (status, restart, logs).

## Phase 2 — Ollama prep on Arch host

### 2.1 Make Ollama listen on 0.0.0.0

```sh
sudo systemctl edit ollama
# Add:
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"

sudo systemctl restart ollama
ss -tlnp | grep 11434     # should show 0.0.0.0:11434
```

### 2.2 Verify reachable from inside cluster

```sh
kubectl run -it --rm test --image=alpine -- sh -c "wget -qO- http://192.168.1.163:11434/api/tags"
```

**Acceptance:** returns Ollama's tags JSON.

## Phase 3 — `arch-infra` registration

### 3.1 Add `apps/llmgw.yaml`

Argo CD Application pointing at this repo's `deploy/chart`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: llmgw
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/autumnfallenwang/llm-gateway.git
    targetRevision: main
    path: deploy/chart
    helm:
      valueFiles:
        - values.yaml
      parameters:
        - name: image.tag
          value: <SHA>            # GHA will sed this on each build
  destination:
    server: https://kubernetes.default.svc
    namespace: llmgw
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

### 3.2 Add Ollama Service + Endpoints

`arch-infra/apps/llmgw-ollama.yaml` (or include in chart's templates):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ollama
  namespace: llmgw
spec:
  ports:
    - port: 11434
      targetPort: 11434
---
apiVersion: v1
kind: Endpoints
metadata:
  name: ollama
  namespace: llmgw
subsets:
  - addresses:
      - ip: 192.168.1.163
    ports:
      - port: 11434
```

(Putting it in chart templates is cleaner — colocated with the app that uses it.)

## Phase 4 — Cutover

1. Push everything (commit phase 1 changes, GHA fires, image lands in GHCR, `arch-infra` gets bumped).
2. Wait for Argo CD sync (~3 min, or trigger refresh).
3. Verify pod up: `kubectl get pods -n llmgw`.
4. Add `192.168.1.163 llmgw.arch.local` to `/etc/hosts`.
5. Smoke test: `curl http://llmgw.arch.local/`.
6. Validate: `curl -X POST http://llmgw.arch.local/v1/models/validate`. Expect models OK.
7. Verify logs in Loki: `{namespace="llmgw"}` in Grafana, or curl Loki API.
8. Verify Ollama path: hit a model endpoint that requires Ollama.
9. **Stop the old version**: `cd ~/agentic/llm-gateway && docker compose -f deploy/compose.yaml down`.
10. Confirm host port 51277 is free: `ss -tlnp | grep 51277` returns nothing.

## Rollback plan

- If pod doesn't start: `kubectl describe pod` and `kubectl logs` show why. Common causes: image pull (GHA didn't run), PVC bind, hostPath missing.
- If validation fails: keep docker compose running (don't run step 9). Logs: `{namespace="llmgw"} |= "error"`.
- Worst case: `kubectl delete application llmgw -n argocd` (Argo CD prunes); `git revert` the bump in arch-infra.

## Acceptance for "migration complete"

- Pod running in `llmgw` namespace, healthy.
- `http://llmgw.arch.local` responds with 200.
- `/v1/models/validate` returns expected models OK.
- Logs flowing into Loki under `{namespace="llmgw"}`.
- Old docker compose container stopped.
- Host port 51277 free.
- A second iteration (push a trivial change to `main`) successfully rebuilds and redeploys via GHA + Argo CD.
