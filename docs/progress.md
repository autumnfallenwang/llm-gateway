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
| 8 | Tests | ✅ Done | 9 test files, 143 fast / 230 total tests |
| 9 | Model validation | ✅ Done | `src/services/validation.ts` — tests every model with real completion, saves to `~/.llm-gateway/models.json` |
| 10 | Streaming support | ✅ Done | SSE streaming via `stream: true` — all three backends (Ollama, Anthropic, Codex) |

## What's Working

- `npm run dev` → `:51277`, Swagger UI at `/docs`
- Full request validation with OpenAI-format errors (`message`, `type`, `param`, `code`)
- `POST /v1/chat/completions` → routes to Ollama/Anthropic/Codex via pi-ai, returns OpenAI-format response
- `POST /v1/chat/completions` with `stream: true` → SSE streaming with `chat.completion.chunk` objects, `data: [DONE]` sentinel
- `GET /v1/models` → returns only validated models (if validation has been run), all models otherwise; includes `context_window` and `max_tokens` per model
- `POST /v1/models/validate` → tests every registered model, saves results to `~/.llm-gateway/models.json`, filters broken models from `GET /v1/models`
- Model registry discovers Ollama, Anthropic, Codex models at startup
- Completion service translates OpenAI ↔ pi-ai (system prompt extraction, message conversion, usage/stopReason mapping)
- Streaming uses pi-ai `stream()` → async generator yields OpenAI chunk JSON → Hono `streamSSE()` writes SSE events
- Codex provider gets default system prompt when none provided
- 404 with `model_not_found` for unknown models, classified backend errors: 400 `context_length_exceeded`, 429 `rate_limit_exceeded`, 500 `server_error`
- Streaming errors sent as SSE error events before stream closes
- Image processing pipeline: `image_url` content parts → load (HTTPS/data URI) → preprocess (resize, compress, format convert) → pi-ai `ImageContent`
- `ImageLoadError` returns 400 `invalid_request_error` (not 500) in both streaming and non-streaming paths
- Ollama `num_ctx` injection: configurable via `OLLAMA_NUM_CTX` env var (default 32768), replaces Ollama's wasteful ~4096 default
- 143 unit tests passing (fast), 0 lint errors, 0 lint warnings
- `npm run test:fast` for dev iteration (~1.7s), `npm test` for full validation

## Reference Docs

- [dev-plan.md](dev-plan.md) — Phase 1 plan (complete)
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
| 11 | Update `MessageSchema` to accept `string \| ContentPart[]` | ✅ Done | Schema union type, `extractTextContent` helper, `buildContext` handles array content, image_url parts filtered (task 14). |
| 12 | Image loader: resolve inputs to buffers | ✅ Done | `src/services/image/load.ts` — data URI decode, HTTPS fetch (timeout, size cap, SSRF protection), MIME detection from magic bytes. 31 tests in `tests/image-load.test.ts`. |
| 13 | Image preprocessor with `sharp` | ✅ Done | `src/services/image/preprocess.ts` — resize, compress, EXIF fix, HEIC→JPEG, WebP conversion, alpha-aware PNG/JPEG grid search, `detail` param support. 15 tests in `tests/image-preprocess.test.ts`. |
| 14 | Integrate pipeline into completion route | ✅ Done | `buildContext` async, `processImagePart` helper, `Promise.all` preserves order, `ImageLoadError` → 400 in both streaming/non-streaming. 5 new tests in `completion.test.ts`. |

### Phase 2.2 — Vision Fallback + Ollama Vision Detection

When target model doesn't support images, describe via a vision model first. Fix Ollama models hardcoded to `input: ["text"]` — critical because pi-ai strips images when `model.input` lacks `"image"`, breaking both direct vision and the fallback chain for Ollama-only setups.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 15 | Fallback model config | ✅ Done | Family-first + general fallback. Per-family vision model (ollama→`qwen3-vl:8b`, anthropic→`claude-haiku-4-5`, openai→`gpt-4o-mini`) then general chain. All env-var overridable. Config in `src/config.ts`. |
| 16 | Vision fallback service | ✅ Done | `src/services/image/fallback.ts` — `applyVisionFallback()` intercepts non-vision models, describes images via family-first + general chain fallback, replaces image parts with text. `VisionFallbackError` → 502 in both streaming/non-streaming. Integrated into `createCompletion` + `createStreamingCompletion`. |
| 17 | Unit tests for vision fallback | ✅ Done | `tests/vision-fallback.test.ts` — 20 tests covering skip paths, fallback model selection (family-first + general chain), image description & replacement, truncation, error handling. |
| 19 | Detect Ollama vision models | ✅ Done | `fetchModelCapabilities()` calls `/api/show` per model, detects `"vision"` capability, extracts `context_length` from `model_info`. `buildOllamaModel` sets `input: ["text", "image"]` for vision models. |
| 20 | Tests for Ollama vision detection | ✅ Done | `tests/ollama.test.ts` — 16 tests (fetchModelCapabilities, extractContextLength, buildOllamaModel). 3 new integration tests in `tests/registry.test.ts`. |
| 18 | E2E tests for image pipeline | ✅ Done | 9 tests: direct vision (data URI + HTTPS URL × 3 backends), vision fallback (Ollama text-only), streaming vision, error handling (invalid data URI). |

## Phase 3: Context Window Management

Research complete. See [context-window-test-results.md](context-window-test-results.md) for full test data.

**Background**: LLM models have finite context windows. Anthropic/Codex reject overflows with errors; Ollama silently truncates. Our gateway currently swallows all pi-ai `stopReason: "error"` responses, and Ollama's default `num_ctx` (~4096) wastes 97%+ of model capacity. The `/v1/models` endpoint doesn't expose `contextWindow` or `maxTokens`, leaving clients blind.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 21 | Fix gateway error swallowing | ✅ Done | `BackendError` class in `src/errors.ts`. `throwIfBackendError()` in completion service classifies errors: `isContextOverflow()` → 400, rate limit regex → 429, fallback → 500. Both streaming and non-streaming paths. 7 new tests. |
| 22 | Add `OLLAMA_NUM_CTX` config | ✅ Done | `OLLAMA_NUM_CTX` env var (default 32768) in `src/config.ts`. Injected via pi-ai `onPayload` callback in `buildOptions()` for Ollama providers. 2 new tests in `completion.test.ts`. |
| 23 | Expose `contextWindow` and `maxTokens` in `/v1/models` | ✅ Done | `context_window` and `max_tokens` added to `ModelObjectSchema` (optional ints). `listModels()` maps pi-ai `contextWindow`/`maxTokens` to snake_case. 1 new test in `app.test.ts`. |

## Phase 4: Provider Expansion & Tooling

See [backlog.md](backlog.md) for full details and research notes.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 24 | Replace llava with qwen3-vl:8b as default vision fallback | ✅ Done | Changed `VISION_FALLBACK_OLLAMA` and `VISION_FALLBACK_GENERAL` defaults from `llava` to `qwen3-vl:8b` in `src/config.ts`. Updated Swagger example, CLAUDE.md docs, and vision-fallback tests. |
| 25 | Enrich /v1/models with validation status | Planned | Return ALL models with `status` (`ok`/`error`/`unknown`), `status_detail`, `validated_at` instead of filtering out failed models. Update `ModelObjectSchema`, remove filter logic in app handler. |
| 26 | `llmgw update` — dependency update pipeline | Planned | New CLI subcommand: `npm outdated` → `npm update` → `npm test` → rebuild or rollback. Full dep scope. |
| 27 | Add Gemini provider support | Planned | Fourth backend via pi-ai `google-gemini-cli`. Auth from `~/.gemini/oauth_creds.json` (OAuth token + projectId via `loadCodeAssist` API). Models: gemini-2.0-flash, 2.5-flash, 2.5-pro, 3-flash-preview, 3-pro-preview. Smoke tested with pi-ai `complete()`. Changes: auth.ts, config.ts, registry.ts, completion.ts, vision fallback, tests. |

## Previous Milestones

Phase 1 backend + streaming + Docker deploy complete. See tasks 1–10 above.
Phase 2 image processing pipeline complete. See tasks 11–20 above.
Phase 3 context window management complete. See tasks 21–23 above.
