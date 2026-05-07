# LLM Gateway — Progress

## Dev Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Project setup | ✅ Done | Hono + Biome + Vitest + tsx, all config files |
| 2 | Zod schemas | ✅ Done | `src/schemas/{error,chat,models,validate}.ts` |
| 3 | Auth module | ✅ Done | `src/services/auth.ts` — Anthropic OAuth + Codex JWT + Gemini OAuth |
| 4 | Model registry | ✅ Done | `src/services/registry.ts` + `src/lib/ollama.ts` — discover & resolve models |
| 5 | Completion service | ✅ Done | `src/services/completion.ts` — OpenAI ↔ pi-ai translation, Codex system prompt fallback |
| 6 | Routes | ✅ Done | `src/routes/{chat,models,validate}.ts` — OpenAPI route defs with request examples |
| 7 | App + server wiring | ✅ Done | All handlers wired: chat completions, models list (with validation filtering), model validation |
| 8 | Tests | ✅ Done | 10 test files, 151 fast / 244 total tests |
| 9 | Model validation | ✅ Done | `src/services/validation.ts` — tests every model with real completion, saves to `~/.llm-gateway/models.json` |
| 10 | Streaming support | ✅ Done | SSE streaming via `stream: true` — all four backends (Ollama, Anthropic, Codex, Gemini) |

## What's Working

- `npm run dev` → `:51277`, Swagger UI at `/docs`
- Full request validation with OpenAI-format errors (`message`, `type`, `param`, `code`)
- `POST /v1/chat/completions` → routes to Ollama/Anthropic/Codex/Gemini via pi-ai, returns OpenAI-format response
- `POST /v1/chat/completions` with `stream: true` → SSE streaming with `chat.completion.chunk` objects, `data: [DONE]` sentinel
- `GET /v1/models` → returns ALL models with `status` (`ok`/`error`/`unknown`), `status_detail`, `validated_at` fields; includes `context_window` and `max_tokens` per model
- `POST /v1/models/validate` → tests every registered model, saves results to `~/.llm-gateway/models.json`
- Model registry discovers Ollama, Anthropic, Codex, Gemini models at startup
- Completion service translates OpenAI ↔ pi-ai (system prompt extraction, message conversion, usage/stopReason mapping)
- Streaming uses pi-ai `stream()` → async generator yields OpenAI chunk JSON → Hono `streamSSE()` writes SSE events
- Codex provider gets default system prompt when none provided
- 404 with `model_not_found` for unknown models, classified backend errors: 400 `context_length_exceeded`, 429 `rate_limit_exceeded`, 500 `server_error`
- Streaming errors sent as SSE error events before stream closes
- Image processing pipeline: `image_url` content parts → load (HTTPS/data URI) → preprocess (resize, compress, format convert) → pi-ai `ImageContent`
- `ImageLoadError` returns 400 `invalid_request_error` (not 500) in both streaming and non-streaming paths
- Ollama `num_ctx` injection: configurable via `OLLAMA_NUM_CTX` env var (default 32768), replaces Ollama's wasteful ~4096 default
- Gemini OAuth: token refresh via pi-ai `refreshGoogleCloudToken`, project discovery via `loadCodeAssist` API, persists refreshed tokens
- 151 unit tests passing (fast), 244 total tests, 0 lint errors, 0 lint warnings
- `npm run test:fast` for dev iteration (~1.7s), `npm test` for full validation

## Reference Docs

- [dev-plan.md](dev-plan.md) — Phase 1 plan (complete)
- [openai-chat-completions-spec.md](openai-chat-completions-spec.md) — request/response fields
- [ollama-openai-compatibility-spec.md](ollama-openai-compatibility-spec.md) — Ollama compat matrix
- [openai-error-spec.md](openai-error-spec.md) — error format + gateway error mapping
- [openai-vision-spec.md](openai-vision-spec.md) — vision API facts, pi-ai behavior, OpenClaw fallback policy
- [openai-embeddings-spec.md](openai-embeddings-spec.md) — embeddings API spec + Ollama passthrough + routing decisions (Phase 5; written before route implementation)
- [image-processing-plan.md](image-processing-plan.md) — full image processing architecture plan
- [llmgw-embeddings-hotfix.md](llmgw-embeddings-hotfix.md) — embeddings hotfix handoff (Phase 5)
- [llmgw-anthropic-auth-hotfix.md](llmgw-anthropic-auth-hotfix.md) — Anthropic auth hotfix handoff (Phase 6)

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
| 18 | E2E tests for image pipeline | ✅ Done | 13 tests: direct vision (data URI + HTTPS URL × 4 backends), vision fallback (Ollama text-only), streaming vision, error handling (invalid data URI). |

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
| 25 | Enrich /v1/models with validation status | ✅ Done | `ModelObjectSchema` gains `status`, `status_detail`, `validated_at`. App handler enriches ALL models instead of filtering. 3 new tests in `app.test.ts`. |
| 26 | `llmgw update` — dependency update pipeline | ✅ Done | CLI subcommand: `npm outdated` → `npm update` → `npm test` → rebuild or rollback. Full dep scope. |
| 27 | Add Gemini provider support | ✅ Done | Fourth backend via pi-ai `google-gemini-cli`. Auth from `~/.gemini/oauth_creds.json` (OAuth token refresh + projectId via `loadCodeAssist` API). Config, auth, registry, vision fallback, route examples, unit + e2e tests all updated. |

## Phase 5: Embeddings Support

Hotfix surfaced from a homenews semantic-search debugging session. See [llmgw-embeddings-hotfix.md](llmgw-embeddings-hotfix.md) for the original handoff (POC logs, debugging context) and [backlog.md](backlog.md#5-embeddings-hotfix--add-post-v1embeddings--per-capability-validation) for scope.

**Background**: `POST /v1/embeddings` does not exist (404). The validator also POSTs chat-completions to embedding models, producing false-positive `error` states. Both bugs are visible against `bge-m3:latest`, `qwen3-embedding:0.6b`, `nomic-embed-text:latest`. All three work natively against Ollama's OpenAI-compatible endpoint.

**Workflow** (research → spec → implementation → tests, matching the precedent set by `openai-chat-completions-spec.md` + `openai-vision-spec.md`):

1. **Research** the OpenAI `/v1/embeddings` standard (request/response schema, batch input, encoding_format, dimensions param, error envelope, streaming behavior — embeddings don't stream).
2. **Write `docs/openai-embeddings-spec.md`** as the canonical reference (request fields, response fields, status codes, gateway-specific decisions like routing-by-`owned_by`).
3. **Probe Ollama** `/v1/embeddings` against all three local embedders (`bge-m3:latest`, `qwen3-embedding:0.6b`, `nomic-embed-text:latest`) — confirm exact response shape, dimensions, batch behavior, error format. Append findings to the spec doc.
4. **Implement** schemas + route + service per the spec.
5. **Validator dispatch** by capability so embedders stop showing as false-positive `error`.
6. **Unit + e2e tests** mirroring the spec doc's example requests.
7. **Swagger** `/docs` exposes the new route via `@hono/zod-openapi` automatically once the route is registered with examples.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 28 | Tag models with `capability` at registry discovery | ✅ Done | `Capability = "chat" \| "embedding"` in `src/services/registry.ts`. `OllamaModelCapabilities` extended with `supportsEmbedding`/`supportsCompletion` (read from Ollama `/api/show` `capabilities` array). `fetchOllamaModels()` now returns `{ model, capabilities }[]`. `ResolvedModel` and `listModels()` carry `capability`. Anthropic/Codex/Gemini hardcoded `"chat"`. New: `bge-m3:latest` registry test, embedding/completion/hybrid tests in `ollama.test.ts`. Vision is intentionally `chat` (still routes to chat completions). |
| 29a | **Research**: write `docs/openai-embeddings-spec.md` | ⏳ Planned | Capture the OpenAI `/v1/embeddings` standard from `platform.openai.com/docs/api-reference/embeddings`: request fields (`model`, `input` string-or-array, `encoding_format`, `dimensions`, `user`), response shape (`object: "list"`, `data[]` with `{object, index, embedding}`, `model`, `usage{prompt_tokens, total_tokens}`), error envelope, status codes. Section "Gateway Decisions" records: route-by-`owned_by` (ollama passthrough; anthropic/codex/gemini → 501), batch-input handling (passthrough), encoding_format (passthrough — Ollama supports both `"float"` and `"base64"`), dimensions param (passthrough; only some models honor it). |
| 29b | **POC**: probe Ollama against `bge-m3` / `qwen3-embedding` / `nomic-embed-text` | ✅ Done | All 3 embedders confirmed byte-for-byte OpenAI-compatible at expected dims (1024/1024/768). Batch input, base64 encoding, `dimensions` truncation all work. Error path: Ollama returns `type: "not_found_error"` + `code: null` on unknown model — diverges from our envelope, so route handler must rewrap. `dimensions` works on bge-m3 (broader than OpenAI spec implies — don't gate it). POC log appended to `docs/openai-embeddings-spec.md`. |
| 29c | Schemas + route + service | ✅ Done | `src/schemas/embeddings.ts` — Zod request (model, input string-or-array, encoding_format, dimensions, user) + response (object/data/model/usage). Token-array inputs intentionally excluded since Ollama rejects them; cleaner 400 at our layer. `src/services/embeddings.ts` — `createEmbedding(resolved, body)` with provider gate (501 `provider_unsupported` for non-ollama), capability gate (400 `wrong_capability` for non-embedding models), fetch passthrough to `${OLLAMA_BASE_URL}/v1/embeddings`, BackendError mapping for upstream 400/404/429/5xx + network failures. `src/routes/embeddings.ts` — createRoute with 5 example bodies (single, batch, base64, dimensions, alt model) and full error responses. `src/app.ts` — registered handler (with mirror gate on `/v1/chat/completions` for embedding-capability models), Embeddings OpenAPI tag added. `src/errors.ts` — BackendError accepts optional `cause` for error chaining. **17 new unit tests** in `tests/embeddings.test.ts` covering all gates + passthrough + upstream error mapping. **185 unit tests pass** (up from 168). |
| 30 | Per-capability validation | ✅ Done | `src/services/validation.ts` split into `validateChatModel` (existing pi-ai `complete()` flow) + `validateEmbeddingModel` (new — calls `createEmbedding(resolved, {input:"test"})`, fails on empty/zero-length vector, records `embeddingDim` on success). `validateSingleModel` dispatches by `resolved.capability`. `createEmbedding()` now accepts an `EmbeddingsOptions { signal? }` for AbortSignal-based timeouts. `embeddingDim?: number` added to `ModelValidationResultSchema`. **14 new unit tests** in `tests/validation.test.ts` covering both paths. After deploy, `/v1/models/validate` will promote `bge-m3:latest`, `qwen3-embedding:0.6b`, `nomic-embed-text:latest` from false-positive `error` → `ok` with their dimensions recorded. **200 unit tests pass** (up from 185). |
| 31 | Expose `embedding_dimensions` in `/v1/models` | ✅ Done | `embedding_dimensions?: number` added to `ModelObjectSchema`. `/v1/models` handler populates it from `result.embeddingDim` (set by task 30's validator). Spread is conditional — chat models never carry the field even when validated. New test in `tests/app.test.ts` verifies bge-m3 → `embedding_dimensions: 1024`, qwen3:30b → undefined. **201 unit tests pass.** |
| 32a | Unit tests | ⏳ Planned | `tests/embeddings.test.ts` — Ollama passthrough (mock fetch, assert request body + response forwarding), 501 for anthropic/codex/gemini, 404 for unknown model, error envelope on upstream non-2xx. `tests/validation.test.ts` extended for capability dispatch. |
| 32b | E2E tests | ⏳ Planned | `tests/e2e.test.ts` — real embedding call against `bge-m3:latest` (single + batch input), dimension assertion, validator end-to-end (POST `/v1/models/validate` → embedders show `status: ok`). Skip cleanly if local Ollama lacks the model. |

## Phase 6: Anthropic Auth Hotfix

Production gateway returns `Connection error.` for Anthropic streaming completions. Two stacked bugs: Docker single-file bind-mount inode-pins to a stale token, and `loadAnthropicCredentials()` never actually calls `refreshAnthropicToken()` — the 30-min cron only re-reads the frozen file. See [llmgw-anthropic-auth-hotfix.md](llmgw-anthropic-auth-hotfix.md) for full root-cause and architecture.

**Architecture**: container becomes its own OAuth client — seed from host file once, then maintain an independent refresh-token chain in a writable container volume. Drop the cron; replace with lazy refresh + single-flight mutex on the request path (what the Claude CLI itself does).

| # | Task | Status | Notes |
|---|------|--------|-------|
| 33 | `deploy/compose.yaml`: directory bind-mount + reuse writable volume | ✅ Done | `~/.claude:/home/node/host-claude:ro` (directory, not file) — same for `~/.codex`. Cache lives in existing `~/.llm-gateway` volume. New env vars: `ANTHROPIC_SEED_PATH`, `ANTHROPIC_CACHE_PATH`. `CODEX_CREDENTIALS_PATH` repointed at `host-codex/auth.json`. |
| 34 | `src/services/auth.ts`: container-private cache + lazy refresh + mutex | ✅ Done | New `AnthropicCredsState` (access/refresh/expires), `readAnthropicFile`/`writeAnthropicCache` helpers. `loadAnthropicCredentials()` prefers cache; falls back to seed + immediate `performAnthropicRefresh()`. Public `ensureAnthropicFresh()` checks `expires - ANTHROPIC_REFRESH_SKEW_MS` (default 60s), single-flight via `anthropicRefreshInFlight` promise. Drops `CREDENTIAL_REFRESH_INTERVAL_MS` from `src/config.ts`; adds `ANTHROPIC_SEED_PATH`, `ANTHROPIC_CACHE_PATH`, `ANTHROPIC_REFRESH_SKEW_MS`. |
| 35 | `src/index.ts`: drop the `setInterval` cron | ✅ Done | Removed the 30-min cron block and `CREDENTIAL_REFRESH_INTERVAL_MS` import. Bootstrap `loadCredentials()` still runs once at startup. |
| 36 | Route handler: call `ensureAnthropicFresh()` before resolving Anthropic models | ✅ Done | `src/app.ts` chat completions handler: when `resolved.provider === "anthropic"`, awaits `ensureAnthropicFresh()`, then re-resolves so `resolved.apiKey` carries the fresh token. Refresh errors return 500 with `anthropic_auth_failed` code. |
| 37 | Tests | ✅ Done | `tests/auth.test.ts` rewritten with `vi.mock` partial of `refreshAnthropicToken`: cache bootstrap (no refresh), seed bootstrap + immediate refresh + cache write-through, seed without refresh_token rejected, fresh-token skip, expired refresh, safety-skew refresh, single-flight mutex (10 concurrent → 1 refresh), refresh write-through, no-op when unavailable, mutex clears on error. `tests/registry.test.ts` updated to use `anthropicSeedPath`/`anthropicCachePath` (cache path so no refresh fires) and adds `refreshToken` to fixture. **168 unit tests pass.** |

**Out of scope (follow-ups)**: Codex lazy refresh via `refreshOpenAICodexToken`, Gemini write-to-cache instead of host file. Both are architecturally identical to the Anthropic fix but not currently breaking production.

## Previous Milestones

Phase 1 backend + streaming + Docker deploy complete. See tasks 1–10 above.
Phase 2 image processing pipeline complete. See tasks 11–20 above.
Phase 3 context window management complete. See tasks 21–23 above.
Phase 4 provider expansion & tooling complete. See tasks 24–27 above.
