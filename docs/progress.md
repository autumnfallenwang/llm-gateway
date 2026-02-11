# LLM Gateway — Phase 1 Progress

## Dev Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Project setup | ✅ Done | Hono + Biome + Vitest + tsx, all config files |
| 2 | Zod schemas | ✅ Done | `src/schemas/{error,chat,models}.ts` — includes `param` field fix |
| 3 | Auth module | ✅ Done | `src/services/auth.ts` — Anthropic OAuth + Codex JWT |
| 4 | Model registry | ✅ Done | `src/services/registry.ts` + `src/lib/ollama.ts` — discover & resolve models |
| 5 | Completion service | ✅ Done | `src/services/completion.ts` — OpenAI ↔ pi-ai translation |
| 6 | Routes | ✅ Done | `src/routes/{chat,models}.ts` — OpenAPI route defs |
| 7 | App + server wiring | ✅ Done | Real handlers wired: resolveModel + createCompletion for chat, listModels for models |
| 8 | Tests | ✅ Done | 35/35 passing (validation + completion + auth + registry + integration) |

## What's Working

- `npm run dev` → `:8080`, Swagger UI at `/docs`
- Full request validation with OpenAI-format errors (`message`, `type`, `param`, `code`)
- `POST /v1/chat/completions` → routes to Ollama/Anthropic/Codex via pi-ai, returns OpenAI-format response
- `GET /v1/models` → returns discovered models from all backends
- Model registry discovers Ollama, Anthropic, Codex models at startup
- `resolveModel(id)` → returns Model + provider + apiKey for routing
- Completion service translates OpenAI ↔ pi-ai (system prompt extraction, message conversion, usage/stopReason mapping)
- 404 with `model_not_found` for unknown models, 500 with backend error details on failure
- 35/35 tests, 0 lint errors

## Reference Docs

- [dev-plan.md](dev-plan.md) — full Phase 1 plan
- [openai-chat-completions-spec.md](openai-chat-completions-spec.md) — request/response fields
- [ollama-openai-compatibility-spec.md](ollama-openai-compatibility-spec.md) — Ollama compat matrix
- [openai-error-spec.md](openai-error-spec.md) — error format + gateway error mapping

## What's Next

Phase 1 backend is complete. Potential next steps:
- Streaming support (`stream: true`)
- Additional OpenAI fields (top_p, frequency_penalty, etc.)
- Rate limiting, request logging
- Docker/deployment config
