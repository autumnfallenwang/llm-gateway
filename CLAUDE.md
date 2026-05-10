# LLM Gateway

Self-hosted OpenAI-compatible API gateway. Routes requests to Ollama, Anthropic, Codex, Gemini via pi-ai.

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

Docker-based deployment via `deploy/` directory. The `llmgw` CLI is symlinked to `~/.local/bin/` for global access.

- `llmgw start` - build image + start container
- `llmgw stop` - stop container
- `llmgw restart` - restart container
- `llmgw logs` - tail container logs
- `llmgw status` - show running state
- `llmgw rebuild` - force full rebuild + restart
- `llmgw update` - bump all deps to latest (incl. major/minor caps via `ncu -u`), gate on `npm test`, rebuild container, validate models via `POST /v1/models/validate`, then commit + push. Rolls back package.json/package-lock.json if tests fail.
- `llmgw version` - show version from package.json

## Config

Centralized in `src/config.ts`. Key env var overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_GATEWAY_PORT` | `51277` | Server port |
| `LOG_LEVEL` | `info` | pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`). Bump to `debug` for verbose troubleshooting. |
| `LLMGW_DB_PATH` | `~/.llm-gateway/state.db` | SQLite path for the credential chain + model validation report. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_NUM_CTX` | `32768` | Ollama runtime context window size (`num_ctx`) |
| `ANTHROPIC_SEED_PATH` | `~/.claude/.credentials.json` | Read-only seed: host's Claude CLI credentials. Read once on first boot. |
| `ANTHROPIC_CACHE_PATH` | `~/.llm-gateway/anthropic-credentials.json` | Legacy JSON; used only as a one-shot import source when `LLMGW_DB_PATH` is empty. |
| `ANTHROPIC_REFRESH_SKEW_MS` | `60000` | Safety margin before `expiresAt` — refresh fires when `now > expires - skew`. |
| `CODEX_CREDENTIALS_PATH` | `~/.codex/auth.json` | Codex auth file |
| `GEMINI_CREDENTIALS_PATH` | `~/.gemini/oauth_creds.json` | Gemini auth file |
| `VALIDATION_FILE_PATH` | `~/.llm-gateway/models.json` | Legacy JSON; used only as a one-shot import source when the DB has no validation rows. |
| `VALIDATION_CONCURRENCY` | `3` | Parallel model validation limit |
| `VALIDATION_TIMEOUT_MS` | `60000` | Per-model validation timeout |
| `OLLAMA_SHOW_TIMEOUT_MS` | `2000` | Per-model /api/show timeout |
| `VISION_FALLBACK_OLLAMA` | `qwen3-vl:8b` | Ollama family vision fallback model |
| `VISION_FALLBACK_ANTHROPIC` | `claude-haiku-4-5` | Anthropic family vision fallback model |
| `VISION_FALLBACK_OPENAI` | `gpt-4o-mini` | OpenAI family vision fallback model |
| `VISION_FALLBACK_GEMINI` | `gemini-2.0-flash` | Gemini family vision fallback model |
| `VISION_FALLBACK_GENERAL` | `qwen3-vl:8b,claude-haiku-4-5,gpt-4o-mini,gemini-2.0-flash` | General fallback chain (comma-separated) |
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
