# LLM Gateway — Progress

## Dev Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Project setup | ✅ Done | Hono + Biome + Vitest + tsx, all config files |
| 2 | Zod schemas | ✅ Done | `src/schemas/{error,chat,models,validate}.ts` |
| 3 | Auth module | ✅ Done | `src/services/auth.ts` — Anthropic OAuth + Codex JWT |
| 4 | Model registry | ✅ Done | `src/services/registry.ts` + `src/lib/ollama.ts` — discover & resolve models |
| 5 | Completion service | ✅ Done | `src/services/completion.ts` — OpenAI ↔ pi-ai translation, Codex system prompt fallback |
| 6 | Routes | ✅ Done | `src/routes/{chat,models,validate}.ts` — OpenAPI route defs with request examples |
| 7 | App + server wiring | ✅ Done | All handlers wired: chat completions, models list (with validation filtering), model validation |
| 8 | Tests | ✅ Done | 48/48 passing across 5 test files (auth, registry, completion, app, e2e) |
| 9 | Model validation | ✅ Done | `src/services/validation.ts` — tests every model with real completion, saves to `~/.llm-gateway/models.json` |
| 10 | Streaming support | ✅ Done | SSE streaming via `stream: true` — all three backends (Ollama, Anthropic, Codex) |

## What's Working

- `npm run dev` → `:8080`, Swagger UI at `/docs`
- Full request validation with OpenAI-format errors (`message`, `type`, `param`, `code`)
- `POST /v1/chat/completions` → routes to Ollama/Anthropic/Codex via pi-ai, returns OpenAI-format response
- `POST /v1/chat/completions` with `stream: true` → SSE streaming with `chat.completion.chunk` objects, `data: [DONE]` sentinel
- `GET /v1/models` → returns only validated models (if validation has been run), all models otherwise
- `POST /v1/models/validate` → tests every registered model, saves results to `~/.llm-gateway/models.json`, filters broken models from `GET /v1/models`
- Model registry discovers Ollama, Anthropic, Codex models at startup
- Completion service translates OpenAI ↔ pi-ai (system prompt extraction, message conversion, usage/stopReason mapping)
- Streaming uses pi-ai `stream()` → async generator yields OpenAI chunk JSON → Hono `streamSSE()` writes SSE events
- Codex provider gets default system prompt when none provided
- 404 with `model_not_found` for unknown models, 500 with backend error details on failure
- Streaming errors sent as SSE error events before stream closes
- 48/48 tests, 0 lint errors

## Reference Docs

- [dev-plan.md](dev-plan.md) — full Phase 1 plan
- [openai-chat-completions-spec.md](openai-chat-completions-spec.md) — request/response fields
- [ollama-openai-compatibility-spec.md](ollama-openai-compatibility-spec.md) — Ollama compat matrix
- [openai-error-spec.md](openai-error-spec.md) — error format + gateway error mapping
- [openai-vision-spec.md](openai-vision-spec.md) — vision API facts, pi-ai behavior, OpenClaw fallback policy
- [image-processing-plan.md](image-processing-plan.md) — full image processing architecture plan

## Phase 2: Image Processing

Three phases, built incrementally. See [image-processing-plan.md](image-processing-plan.md) for full architecture, [openai-vision-spec.md](openai-vision-spec.md) for research facts.

### Phase 2.1 — Image Preprocessing + Pass-through

Core pipeline: accept images, preprocess, pass to pi-ai. Vision models work; non-vision models silently ignore (pi-ai default).

| # | Task | Status | Notes |
|---|------|--------|-------|
| 11 | Update `MessageSchema` to accept `string \| ContentPart[]` | | `content` as union type, add `image_url` content part schema |
| 12 | Image loader: resolve inputs to buffers | | Decode base64 data URIs, fetch HTTPS URLs (timeout, size cap, SSRF protection), MIME detection from magic bytes |
| 13 | Image preprocessor with `sharp` | | Resize, compress, EXIF fix, HEIC→JPEG, alpha detection, grid search for size limits, `detail` param support |
| 14 | Integrate pipeline into completion route | | Parse content parts → load → preprocess → convert to pi-ai `ImageContent` → pass to `buildContext` |
| 15 | Tests for image pipeline | | Unit tests for loader, preprocessor, content parsing; integration test for full flow |

### Phase 2.2 — Vision Fallback

When target model doesn't support images, describe via a vision model first.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 16 | Vision fallback service | | Check `model.input.includes("image")`, select fallback vision model, describe image as text |
| 17 | Fallback model config | | Priority: config override → auto-detect by available API keys. Default chain: `gpt-4o-mini` → `claude-haiku-4-5` |
| 18 | Tests for vision fallback | | Mock vision model response, verify text replacement, verify skip when model supports vision |

### Phase 2.3 — Ollama Vision Detection

Fix Ollama models hardcoded to `input: ["text"]`.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 19 | Detect Ollama vision models | | Name heuristic or `/api/show` endpoint, set `input: ["text", "image"]` in `buildOllamaModel` |
| 20 | Tests for Ollama vision detection | | |

## Previous Milestones

Phase 1 backend + streaming + Docker deploy complete. See tasks 1–10 above.
