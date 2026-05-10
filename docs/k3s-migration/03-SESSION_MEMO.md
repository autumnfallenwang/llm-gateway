# Session Memo — Locked Decisions

For resuming the migration in another session. Decisions only, no exploration.

## Stack

- k3s on Arch box (192.168.1.163), single node, already running.
- Argo CD (GitOps, pull-based, NAT-friendly) — already installed.
- GitHub Actions for CI; GHCR for images.
- Loki + Grafana + Alloy in `observability` namespace — already running.

## Repos

- `autumnfallenwang/arch-infra` — cluster source of truth (public).
- `autumnfallenwang/llm-gateway` — this repo (public).
- Pattern C: app source + Helm chart in app repo's `deploy/chart/`; arch-infra holds only the ArgoCD Application CR.

## llmgw migration — locked decisions

| Topic | Decision |
|---|---|
| Storage for credentials cache + models registration | **PVC + SQLite** (`better-sqlite3`). 1Gi local-path. Mount at `/home/node/.llm-gateway/`. |
| Credentials seed (`.claude`, `.codex`) | **`hostPath` RO** — live view of host files, refreshes naturally. |
| Ollama access from pod | **Reconfigure host Ollama → 0.0.0.0:11434**. Then **Service + manual Endpoints** in `llmgw` namespace pointing to `192.168.1.163:11434`. App uses `http://ollama.llmgw:11434`. |
| Container port | Keep **51277** (app's natural port). Service maps **`port: 80 → targetPort: 51277`**. |
| Ingress | `llmgw.arch.local` via Traefik. |
| Container user | **non-root** (USER node, UID 1000). securityContext enforces. |
| `network_mode: host` | **dropped** (incompatible with k8s networking model). |
| `deploy/llmgw` shell wrapper | **retired** post-cutover. |
| CI | GHA: PR → test; main → test + build + push to GHCR + bump tag in arch-infra. |
| CD | Argo CD pulls arch-infra every ~3 min. No webhook. |

## Conventions inherited from session

- **Hostname = identity, port = plumbing.** Each app gets `<app>.arch.local`. Service ports normalize to :80 (or whatever native, e.g. :3100 for Loki).
- **Cluster-internal addressing:** `<svc>.<ns>` (short form), `<svc>.<ns>.svc.cluster.local` (full form).
- **DBs are app-owned**, deployed per namespace (Bitnami Postgres chart, image override for pgvector where needed). Not platform-shared.
- **Secrets:** Sealed Secrets to be installed before first DB password lands in git. Skipped for llmgw (no DB password).
- **Loki retention:** 14d default, 3d for kube-system/argocd/observability, 30d for app namespaces (rules dormant until namespaces exist).

## Build sequence — status

- ✅ Phases 1–6: arch-infra + k3s + Argo CD + observability stack
- ⏳ **Phase 7: llmgw migration** ← current
- ⬜ Phase 8+: Sealed Secrets, homecal, homenews

## Where to start in a fresh session

1. Read this memo + `01-PLAN.md` (detailed plan) + `02-K3S_REFERENCE.md` (system context).
2. Begin Phase 1 of `01-PLAN.md`:
   - Add `better-sqlite3`, refactor `services/auth.ts` and validation handler to use SQLite.
   - Update `deploy/Dockerfile` (USER node, build deps for native module).
   - Create `deploy/chart/` Helm scaffold.
   - Create `.github/workflows/build.yml`.
3. Phase 2: reconfigure Ollama to listen 0.0.0.0.
4. Phase 3: register `apps/llmgw.yaml` in arch-infra.
5. Phase 4: cutover (push, wait, smoke test, stop old compose).

## Things explicitly NOT chosen (don't revisit)

- ❌ Keep raw JSON files (rejected: no atomic writes, no schema, hard to query).
- ❌ Run Postgres for two JSON files (rejected: overkill).
- ❌ `emptyDir` + bootstrap-on-startup (rejected: model validation too slow to redo every restart).
- ❌ Run Ollama in k3s now (deferred: needs GPU passthrough, separate effort).
- ❌ Host networking / hostPort (rejected: defeats k8s networking model).
- ❌ Webhook from GHA → Argo CD (rejected: defeats NAT advantage; 3-min poll is fine).
- ❌ Self-hosted runner for deploy step (rejected: pure pull-based GitOps is cleaner).
- ❌ Jenkins / Drone / Woodpecker (rejected: GHA + Argo CD is the modern pattern).
- ❌ Single shared Postgres for multiple apps (rejected: different images, isolation lost).
- ❌ Minikube for ongoing hosting (rejected: it's a dev sandbox, not for live workloads).
