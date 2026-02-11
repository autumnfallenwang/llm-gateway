# LLM Gateway

Self-hosted OpenAI-compatible API gateway. Routes requests to Ollama, Anthropic, Codex via pi-ai.

## Stack

Hono + Zod + @hono/zod-openapi + Vitest + Biome + tsx

## Commands

- `npm run dev` - start dev server (port 8080)
- `npm test` - run tests
- `npm run lint` - lint check
- `npm run lint:fix` - auto-fix lint

## Docs

- [docs/dev-plan.md](docs/dev-plan.md) - Phase 1 development plan
- [docs/openai-chat-completions-spec.md](docs/openai-chat-completions-spec.md) - OpenAI API spec reference
- [docs/ollama-openai-compatibility-spec.md](docs/ollama-openai-compatibility-spec.md) - Ollama compatibility analysis
- [docs/openai-error-spec.md](docs/openai-error-spec.md) - OpenAI error response format + gateway error mapping
- [docs/progress.md](docs/progress.md) - Current progress tracker
