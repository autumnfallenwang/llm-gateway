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
- `llmgw version` - show version from package.json

## Config

Centralized in `src/config.ts`. Key env var overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_GATEWAY_PORT` | `51277` | Server port |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_NUM_CTX` | `32768` | Ollama runtime context window size (`num_ctx`) |
| `ANTHROPIC_CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Anthropic auth file |
| `CODEX_CREDENTIALS_PATH` | `~/.codex/auth.json` | Codex auth file |
| `GEMINI_CREDENTIALS_PATH` | `~/.gemini/oauth_creds.json` | Gemini auth file |
| `VALIDATION_FILE_PATH` | `~/.llm-gateway/models.json` | Validation cache |
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
- [docs/image-processing-plan.md](docs/image-processing-plan.md) - Image processing architecture plan
- [docs/progress.md](docs/progress.md) - Current progress tracker
