# LLM Gateway

Self-hosted OpenAI-compatible API gateway. Routes requests to Ollama, Anthropic, Codex, DeepSeek via pi-ai.

Supports OpenAI tool calling (`tools`, `tool_choice`, `tool` messages) and `reasoning_effort`.
`src/lib/pi.ts` is the only file that imports pi-ai (`@earendil-works/pi-ai`); everything else
imports from it, so a pi-ai API change stays in one file. It also corrects pi-ai's catalog
(`NO_TEMPERATURE`, `RETIRES`, `THINKING_LEVELS`) and maps `reasoning_effort` per API (`reasoningOptions`).

Models are requested by bare ID or `owned_by/model` (`deepseek/deepseek-flash`); a bare ID two providers
share is a 400 `ambiguous_model`. Key anything per-model by `ResolvedModel.id` (the listed ID), never the
bare `model.id`. See [docs/model-ids.md](docs/model-ids.md).

## Stack

Hono + Zod + @hono/zod-openapi + Vitest + Biome + tsx

## Commands

- `npm run dev` - start dev server with hot-reload (port 51277)
- `npm run test:fast` - unit tests only, excludes e2e/compatibility (~0.5s)
- `npm test` - full suite including e2e/compatibility (~5 min). On a dev machine run it as
  `ANTHROPIC_SEED_PATH=/nonexistent npm test`: otherwise the e2e suites seed from and refresh
  `~/.claude/.credentials.json`, rotating the host's own Claude login (refresh tokens are single-use)
- `npm run test:codex-poc` - live GPT check through the host's ChatGPT login (`~/.codex/auth.json`):
  which Codex models the plan answers, plus pi-ai and gateway features on one of them. Opt-in, ~40
  real requests against the plan's quota
- `npm run test:deepseek-poc` - live DeepSeek check through the gateway with the key in
  `~/.deepseek/api_key`. Opt-in, ~25 real requests (well under a cent of the prepaid balance)
- `npm run test:limits-poc` - live `GET /v1/limits` check (GPT, DeepSeek, Ollama; Claude only on the
  cluster, since a local gateway would rotate the host's Claude login)
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
- `POST http://llmgw.llmgw.svc.cluster.local/v1/models/validate` — reload the registry (picks up new `ollama pull` models / new provider IDs since boot) + re-run validation for **every** model (loads each Ollama model on the GPU). A restart validates just the models with no result yet

Dependency upkeep is automated via `.github/dependabot.yml` (weekly PRs for npm +
Docker base + GHA actions; pi-ai grouped separately so new model IDs land in
one focused PR).

**Reachable only from the cluster and arch:** no Ingress, by design. Apps use `http://llmgw.llmgw.svc.cluster.local`; on arch, `/etc/hosts` points that name at the pinned Service IP (`10.43.151.52`).

## Config

Centralized in `src/config.ts`. Key env var overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_GATEWAY_PORT` | `51277` | Server port |
| `LLMGW_ALLOWED_HOSTS` | `llmgw.llmgw.svc.cluster.local,localhost,127.0.0.1,[::1]` | The host names the gateway answers to; anything else gets a 403. Web pages can only call it from its own address. See `src/lib/request-guard.ts`. |
| `LOG_LEVEL` | `info` | pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`). Bump to `debug` for verbose troubleshooting. |
| `LLMGW_DB_PATH` | `~/.llm-gateway/state.db` | SQLite path for the credential chain + model validation report. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_NUM_CTX` | `32768` | Ollama runtime context window size (`num_ctx`) |
| `ANTHROPIC_SEED_PATH` | `~/.claude/.credentials.json` | Read-only seed: host's Claude CLI credentials. Read once on first boot, then DB-backed. |
| `ANTHROPIC_REFRESH_SKEW_MS` | `60000` | Safety margin before `expiresAt` — refresh fires when `now > expires - skew`. |
| `CODEX_CREDENTIALS_PATH` | `~/.codex/auth.json` | Codex auth file: a ChatGPT login (any plan with Codex; Go gets `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna`). Read-only — the host's Codex client refreshes it (tokens last 10 days) and the gateway re-reads it when it changes. |
| `CODEX_ENABLED` | `true` | Load Codex credentials + register Codex models. Set `false` on a host with no ChatGPT login so the models don't surface as validation errors. |
| `DEEPSEEK_CREDENTIALS_PATH` | `~/.deepseek/api_key` | DeepSeek's static API key (metered, prepaid), plain text, mode 600 — the key's single source of truth on the host (`~/.zshrc` reads it for ccsw). No file, no DeepSeek models. Re-read when it changes. See [docs/deepseek-provider.md](docs/deepseek-provider.md). |
| `LIMITS_CACHE_MS` | `60000` | How long `/v1/limits` reuses an account-usage endpoint result before fetching again. See [docs/usage-limits.md](docs/usage-limits.md). |
| `LIMITS_STALE_MS` | `600000` | When the usage endpoints keep failing, limits older than this report `status: "unknown"`. |
| `LIMITS_WARN_PERCENT` | `80` | A window at or above this percent used is a `warning`. |
| `LIMITS_WARN_BALANCE` | `1` | A prepaid balance (DeepSeek) below this is a `warning`. |
| `LIMITS_FETCH_TIMEOUT_MS` | `10000` | Timeout for one account-usage endpoint request. |
| `VALIDATION_CONCURRENCY` | `3` | Parallel model validation limit |
| `VALIDATE_NEW_MODELS_ON_BOOT` | `true` | At startup, validate (in the background) only the models with no stored result, so new Ollama pulls and pi-ai IDs don't sit at `status: "unknown"`. `false` to skip. |
| `VALIDATION_TIMEOUT_MS` | `60000` | Per-model validation timeout |
| `OLLAMA_SHOW_TIMEOUT_MS` | `2000` | Per-model /api/show timeout |
| `VISION_FALLBACK_OLLAMA` | `qwen3-vl:8b` | Ollama family vision fallback model |
| `VISION_FALLBACK_ANTHROPIC` | `claude-haiku-5-5` | Anthropic family vision fallback model |
| `VISION_FALLBACK_OPENAI` | `gpt-6-luna` | OpenAI (Codex) family vision fallback model |
| `VISION_FALLBACK_DEEPSEEK` | `deepseek-flash` | DeepSeek family vision fallback model (describes images for `deepseek-v4-pro`); `""` uses the general chain |
| `VISION_FALLBACK_GENERAL` | `qwen3-vl:8b,claude-haiku-5-5,gpt-6-luna` | General fallback chain (comma-separated) |
| `VISION_FALLBACK_MAX_DESCRIPTION_CHARS` | `1000` | Max chars for vision description |
| `VISION_FALLBACK_TIMEOUT_MS` | `30000` | Vision fallback model timeout |
| `VISION_FALLBACK_CACHE_DAYS` | `30` | Days a vision-fallback description stays cached in SQLite (one per image + message text + describer), so earlier turns' images aren't described again; `0` turns the cache off |

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
- [docs/deepseek-provider.md](docs/deepseek-provider.md) - Phase 11 DeepSeek provider: facts, decisions (pi-ai, key in `~/.deepseek/api_key`, thinking off by default)
- [docs/model-ids.md](docs/model-ids.md) - Phase 12 model IDs: `provider/model`, `ambiguous_model`
- [docs/usage-limits.md](docs/usage-limits.md) - Phase 13 `GET /v1/limits`: POC findings per paid family, the shared format, the store
- [docs/backlog.md](docs/backlog.md) - Backlog of planned work
- [docs/progress.md](docs/progress.md) - Current progress tracker
