# LLM Gateway

Self-hosted OpenAI-compatible API gateway. Routes requests to Ollama, Anthropic, Codex via pi-ai.

## Stack

Hono + Zod + @hono/zod-openapi + Vitest + Biome + tsx

## Commands

- `npm run dev` - start dev server with hot-reload (port 51277)
- `npm run test:fast` - unit tests only, excludes e2e/compatibility (~0.5s)
- `npm test` - full suite including e2e/compatibility (~90s)
- `npm run lint` - lint check
- `npm run lint:fix` - auto-fix lint

### When to use which test command

- **During development** (`/commit`, `/check`, iterating on code): use `test:fast`
- **Completing a feature** (`/dev-task`, pre-merge validation): use `npm test` (full suite)
- **Debugging a specific test**: use `npx vitest run tests/<file>`

## Deploy

GitOps via k3s. CI in `.github/workflows/build.yml` runs on every push to `main`:
test → build image → push `ghcr.io/autumnfallenwang/llm-gateway:{latest,<sha>}` →
bump `image.tag` in `autumnfallenwang/arch-infra` / `apps/llmgw.yaml`. ArgoCD pulls
the bump within ~3 min and rolls the pod. Helm chart lives at `deploy/chart/`.
Host-side Ollama bind drop-in at `deploy/host/`.

Common ops (no project-specific CLI needed):

- `kubectl logs -n llmgw deploy/llmgw -f` — tail (or use Grafana → Explore → Loki for history)
- `kubectl rollout restart deploy/llmgw -n llmgw` — restart pod
- `kubectl get app llmgw -n argocd` — sync state
- `gh workflow run build.yml` — force rebuild without a code change
- `POST http://llmgw.arch.local/v1/models/validate` — re-run model validation

Dependency upkeep is automated via `.github/dependabot.yml` (weekly PRs for npm +
Docker base + GHA actions; pi-ai grouped separately so new model IDs land in
one focused PR).

## Config

Centralized in `src/config.ts`. Key env var overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_GATEWAY_PORT` | `51277` | Server port |
| `LOG_LEVEL` | `info` | pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`). Bump to `debug` for verbose troubleshooting. |
| `LLMGW_DB_PATH` | `~/.llm-gateway/state.db` | SQLite path for the credential chain + model validation report. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_NUM_CTX` | `32768` | Ollama runtime context window size (`num_ctx`) |
| `ANTHROPIC_SEED_PATH` | `~/.claude/.credentials.json` | Read-only seed: host's Claude CLI credentials. Read once on first boot, then DB-backed. |
| `ANTHROPIC_REFRESH_SKEW_MS` | `60000` | Safety margin before `expiresAt` — refresh fires when `now > expires - skew`. |
| `CODEX_CREDENTIALS_PATH` | `~/.codex/auth.json` | Codex auth file |
| `CODEX_ENABLED` | `true` | Load Codex credentials + register Codex models. Cluster sets `false` (no subscription) so Codex models don't surface as validation errors; flip to re-enable. |
| `VALIDATION_CONCURRENCY` | `3` | Parallel model validation limit |
| `VALIDATION_TIMEOUT_MS` | `60000` | Per-model validation timeout |
| `OLLAMA_SHOW_TIMEOUT_MS` | `2000` | Per-model /api/show timeout |
| `VISION_FALLBACK_OLLAMA` | `qwen3-vl:8b` | Ollama family vision fallback model |
| `VISION_FALLBACK_ANTHROPIC` | `claude-haiku-4-5` | Anthropic family vision fallback model |
| `VISION_FALLBACK_OPENAI` | `gpt-4o-mini` | OpenAI family vision fallback model |
| `VISION_FALLBACK_GENERAL` | `qwen3-vl:8b,claude-haiku-4-5,gpt-4o-mini` | General fallback chain (comma-separated) |
| `VISION_FALLBACK_MAX_DESCRIPTION_CHARS` | `1000` | Max chars for vision description |
| `VISION_FALLBACK_TIMEOUT_MS` | `30000` | Vision fallback model timeout |

## Docs

- [docs/dev-plan.md](docs/dev-plan.md) - Phase 1 development plan
- [docs/openai-chat-completions-spec.md](docs/openai-chat-completions-spec.md) - OpenAI API spec reference
- [docs/ollama-openai-compatibility-spec.md](docs/ollama-openai-compatibility-spec.md) - Ollama compatibility analysis
- [docs/openai-error-spec.md](docs/openai-error-spec.md) - OpenAI error response format + gateway error mapping
- [docs/openai-vision-spec.md](docs/openai-vision-spec.md) - Vision API facts + pi-ai behavior + OpenClaw fallback policy
- [docs/openai-embeddings-spec.md](docs/openai-embeddings-spec.md) - Embeddings API spec + Ollama passthrough + gateway routing decisions (Phase 5)
- [docs/structured-logging-spec.md](docs/structured-logging-spec.md) - Phase 7 logging contract: universal JSON shape, pino, field conventions, migration plan
- [docs/image-processing-plan.md](docs/image-processing-plan.md) - Image processing architecture plan
- [docs/llmgw-embeddings-hotfix.md](docs/llmgw-embeddings-hotfix.md) - Phase 5 embeddings hotfix handoff (route + per-capability validation)
- [docs/llmgw-anthropic-auth-hotfix.md](docs/llmgw-anthropic-auth-hotfix.md) - Phase 6 Anthropic auth hotfix handoff (container-private credential chain + lazy refresh)
- [docs/k3s-migration/01-PLAN.md](docs/k3s-migration/01-PLAN.md) - Phase 8 k3s migration plan (Helm chart, GHA → GHCR → arch-infra, cutover)
- [docs/k3s-migration/02-K3S_REFERENCE.md](docs/k3s-migration/02-K3S_REFERENCE.md) - Home k3s cluster reference (architecture, conventions, common ops)
- [docs/k3s-migration/03-SESSION_MEMO.md](docs/k3s-migration/03-SESSION_MEMO.md) - Phase 8 locked decisions
- [docs/backlog.md](docs/backlog.md) - Backlog of planned work
- [docs/progress.md](docs/progress.md) - Current progress tracker
