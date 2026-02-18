# LLM Gateway

Self-hosted OpenAI-compatible API gateway. Routes requests to Ollama, Anthropic, Codex via pi-ai.

## Stack

Hono + Zod + @hono/zod-openapi + Vitest + Biome + tsx

## Commands

- `npm run dev` - start dev server with hot-reload (port 51277)
- `npm test` - run tests (scoped to `tests/` via vitest.config.ts)
- `npm run lint` - lint check
- `npm run lint:fix` - auto-fix lint

## Deploy

Docker-based deployment via `deploy/` directory. The `llmgw` CLI is symlinked to `~/.local/bin/` for global access.

- `llmgw start` - build image + start container
- `llmgw stop` - stop container
- `llmgw restart` - restart container
- `llmgw logs` - tail container logs
- `llmgw status` - show running state
- `llmgw rebuild` - force full rebuild + restart
- `llmgw version` - show version from package.json

## Config

Centralized in `src/config.ts`. Key env var overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_GATEWAY_PORT` | `51277` | Server port |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `ANTHROPIC_CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Anthropic auth file |
| `CODEX_CREDENTIALS_PATH` | `~/.codex/auth.json` | Codex auth file |
| `VALIDATION_FILE_PATH` | `~/.llm-gateway/models.json` | Validation cache |
| `VALIDATION_CONCURRENCY` | `3` | Parallel model validation limit |
| `VALIDATION_TIMEOUT_MS` | `60000` | Per-model validation timeout |

## Docs

- [docs/dev-plan.md](docs/dev-plan.md) - Phase 1 development plan
- [docs/openai-chat-completions-spec.md](docs/openai-chat-completions-spec.md) - OpenAI API spec reference
- [docs/ollama-openai-compatibility-spec.md](docs/ollama-openai-compatibility-spec.md) - Ollama compatibility analysis
- [docs/openai-error-spec.md](docs/openai-error-spec.md) - OpenAI error response format + gateway error mapping
- [docs/openai-vision-spec.md](docs/openai-vision-spec.md) - Vision API facts + pi-ai behavior + OpenClaw fallback policy
- [docs/image-processing-plan.md](docs/image-processing-plan.md) - Image processing architecture plan
- [docs/progress.md](docs/progress.md) - Current progress tracker
