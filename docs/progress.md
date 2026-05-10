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
| 8 | Tests | ✅ Done | 14 test files, 228 fast / 333 total tests |
| 9 | Model validation | ✅ Done | `src/services/validation.ts` — tests every model with real completion, persists report via the SQLite `model_validation` table (Phase 8 / task 40) |
| 10 | Streaming support | ✅ Done | SSE streaming via `stream: true` — all four backends (Ollama, Anthropic, Codex, Gemini) |

## What's Working

- `npm run dev` → `:51277`, Swagger UI at `/docs`
- Full request validation with OpenAI-format errors (`message`, `type`, `param`, `code`)
- `POST /v1/chat/completions` → routes to Ollama/Anthropic/Codex/Gemini via pi-ai, returns OpenAI-format response
- `POST /v1/chat/completions` with `stream: true` → SSE streaming with `chat.completion.chunk` objects, `data: [DONE]` sentinel
- `GET /v1/models` → returns ALL models with `status` (`ok`/`error`/`unknown`), `status_detail`, `validated_at` fields; includes `context_window` and `max_tokens` per model
- `POST /v1/models/validate` → tests every registered model, persists results to the SQLite `model_validation` table (`LLMGW_DB_PATH`, default `~/.llm-gateway/state.db`)
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
- SQLite-backed state: `src/lib/db.ts` opens `LLMGW_DB_PATH` at startup, runs schema migration, and (idempotently) imports legacy `anthropic-credentials.json` + `models.json` into the `credentials_chain` + `model_validation` tables on first boot
- 228 unit tests passing (fast), 14 test files, 0 lint errors, 0 lint warnings
- `npm run test:fast` for dev iteration (~2s), `npm test` for full e2e validation against live Ollama

## What's Next

The remaining work is a tight, ordered sequence rather than a single next task — each step unblocks the next:

1. **Phase 0 GHA prereqs** (owner-only GitHub UI): create fine-grained PAT `ARCH_INFRA_TOKEN` (Contents: write on `arch-infra` only) → add as repo secret in `llm-gateway`. The workflow tolerates these being absent (warn-skips the bump), so they can be done in parallel with step 2, but the GitOps loop only closes once they're in place.
2. **Push `llm-gateway` main** with the Phase 8 commits (task 40–44) so GHA runs and pushes the first `ghcr.io/autumnfallenwang/llm-gateway:latest` image. Without this, the Application's first sync will `ImagePullBackOff`.
3. **GHCR public flip + repo link** (Phase 0.3): after the first build, flip the GHCR package to public and link it to `llm-gateway` with Write role. ArgoCD pulling a private image without an imagePullSecret will fail.
4. **Commit + push `~/github/arch-infra/apps/llmgw.yaml`** (the file drafted in task 45). ArgoCD picks it up within ~3 min and starts syncing.
5. **Task 46 — cutover**: `kubectl get app llmgw -n argocd` shows `Synced`, smoke-test `http://llmgw.arch.local/`, `POST /v1/models/validate` returns expected models, then `cd ~/agentic/llm-gateway && docker compose -f deploy/compose.yaml down`. Confirm host port 51277 is free. Delete `deploy/llmgw` + `deploy/compose.yaml` (keep `deploy/Dockerfile` — still used by GHA).

See [k3s-migration/01-PLAN.md](k3s-migration/01-PLAN.md) §0 + §4 for the cutover acceptance checklist.

## Reference Docs

- [dev-plan.md](dev-plan.md) — Phase 1 plan (complete)
- [openai-chat-completions-spec.md](openai-chat-completions-spec.md) — request/response fields
- [ollama-openai-compatibility-spec.md](ollama-openai-compatibility-spec.md) — Ollama compat matrix
- [openai-error-spec.md](openai-error-spec.md) — error format + gateway error mapping
- [openai-vision-spec.md](openai-vision-spec.md) — vision API facts, pi-ai behavior, OpenClaw fallback policy
- [openai-embeddings-spec.md](openai-embeddings-spec.md) — embeddings API spec + Ollama passthrough + routing decisions (Phase 5; written before route implementation)
- [structured-logging-spec.md](structured-logging-spec.md) — Phase 7 logging contract: universal JSON shape, pino, field conventions, migration plan
- [image-processing-plan.md](image-processing-plan.md) — full image processing architecture plan
- [llmgw-embeddings-hotfix.md](llmgw-embeddings-hotfix.md) — embeddings hotfix handoff (Phase 5)
- [llmgw-anthropic-auth-hotfix.md](llmgw-anthropic-auth-hotfix.md) — Anthropic auth hotfix handoff (Phase 6)
- [k3s-migration/01-PLAN.md](k3s-migration/01-PLAN.md) — Phase 8 detailed migration plan (manifests, GHA, cutover)
- [k3s-migration/02-K3S_REFERENCE.md](k3s-migration/02-K3S_REFERENCE.md) — k3s cluster reference (what's deployed, conventions, common ops)
- [k3s-migration/03-SESSION_MEMO.md](k3s-migration/03-SESSION_MEMO.md) — Phase 8 locked decisions

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
| 32a | Unit tests | ✅ Done | `tests/embeddings.test.ts` (18 tests via `vi.stubGlobal('fetch')`) — provider gates × 4, capability gate × 2, happy passthrough + signal × 6, upstream error mapping × 6. `tests/validation.test.ts` (14 tests) — chat path × 6 + embedding path × 8. Tests added in commits 473c6ab and 214298e. |
| 32b | E2E tests | ✅ Done | New "phase 5: embeddings" block in `tests/e2e.test.ts` with 11 tests: registry tags bge-m3 as embedding capability, single string input (1024-dim), batch input (3 vectors × 1024), encoding_format=base64, dimensions=512 truncation, anthropic embedding → 501, ollama chat-model embedding → 400 wrong_capability, embedder used at /v1/chat/completions → 400, unknown model → 404, validator end-to-end (status:'ok' + embedding_dimensions:1024 surfaced on /v1/models). All 11 pass against live Ollama. |

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

## Phase 7: Structured Logging

Migrate from 29 ad-hoc `console.log/warn/error` calls to JSON-per-line structured logging via `pino`. Adds per-request access logs (currently absent — can't tell which request failed without instrumenting the handler). Universal JSON shape works against Loki today, ELK/Datadog/Splunk tomorrow with no app changes. See [structured-logging-spec.md](structured-logging-spec.md) for the full contract (field naming, level taxonomy, migration mapping, what we don't implement).

**Architecture**: app writes JSON-per-line to stdout only. Docker captures via its existing log driver. Promtail (separate observability stack, out of scope for this phase) tails Docker's capture and ships to Loki. App stays portable — same code works under systemd, Kubernetes, Nomad.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 38 | Spec doc — universal JSON shape, pino choice, migration mapping | ✅ Done | `docs/structured-logging-spec.md` written. Locks the contract: required fields (`time`, `level`, `msg`, `service`, `version`), conventions (`event` namespace, `*_ms` durations, `err` for Errors), level taxonomy, what we explicitly don't implement (file output, transports, alerting). |
| 39a | Logger module + LOG_LEVEL config | ✅ Done | `src/lib/logger.ts` exports configured `pino` instance with `service`/`version` base fields and ISO timestamps. `LOG_LEVEL` env var added to `src/config.ts` (default `"info"`). Deps: `pino@^10.3.1`, `pino-pretty@^13.1.3`. |
| 39b | Migrate 29 `console.*` sites to structured `log.*` calls | ✅ Done | All 29 sites converted across `src/services/auth.ts` (18), `src/lib/ollama.ts` (4), `src/services/validation.ts` (4), `src/services/registry.ts` (1), `src/index.ts` (2). Bracketed `[auth]` strings became `event: "auth.*"` fields; template-string values became typed fields; caught errors became `err` field (auto-serialized by pino). Zero remaining `console.*` calls in `src/`. |
| 39c | Hono request-logging middleware | ✅ Done | `app.use("*")` middleware in `src/app.ts` emits `event: "http.request"` per request with `req_id` (UUID), `method`, `path`, `status`, `latency_ms`. Skip list excludes `/`, `/docs`, `/openapi.json`. `req_id` set on Hono context for handler-level trace stitching. `OpenAPIHono<{ Variables: { req_id: string } }>` typed accordingly. |
| 39d | `deploy/compose.yaml` log size cap | ✅ Done | `logging.driver: json-file` with `max-size: 10m`, `max-file: 5` added. 50MB cap on the host's per-container log directory; rotation handled by Docker. Promtail tails all rotation files so capping doesn't lose downstream history. |
| 39e | Tests | ✅ Done | `tests/logger.test.ts` (5 tests) — module export, config (base fields/level threshold/Error serialization/ISO timestamps) using a parallel pino instance with captured stream (production logger writes via fd1, bypassing process.stdout.write). `tests/app.test.ts` middleware suite (4 tests) — `vi.mock`-spied `log.info` to assert one line per request, status passthrough, skip list, unique req_id. **210 unit tests pass total** (was 201). |

**Out of scope (separate later phases)**:
- Loki + Promtail + Grafana deployment as a separate `~/agentic/observability/` stack — multi-app concern, not specific to llmgw. _(Superseded by Phase 8 — observability stack is already running in the k3s cluster as `observability-loki` / `observability-grafana` / `observability-alloy`. Once llmgw lands in `namespace: llmgw`, Alloy scrapes pod stdout into Loki automatically with no app changes.)_
- Prometheus metrics + dashboards — different problem (numbers vs events); add when we want trend graphs/alerts.
- OpenTelemetry — overkill for a single-service gateway; revisit if multi-service tracing matters.

## Phase 8: k3s Migration

Migrate llmgw off Docker Compose / `network_mode: host` and onto the home k3s cluster (`aaron-desktop-arch`, `192.168.1.163`). Adopts the same GitOps shape (Pattern C) as the rest of the home stack: code + Helm chart in this repo's `deploy/chart/`, ArgoCD `Application` CR in `arch-infra`, GHA pushes images to GHCR and bumps the SHA in arch-infra.

**Architecture**: namespace `llmgw` with Deployment (1 replica, non-root UID 1000), Service `port: 80 → targetPort: 51277`, Ingress `llmgw.arch.local` via Traefik, 1Gi `local-path` PVC at `/home/node/.llm-gateway` for SQLite state, hostPath RO directory mounts for `~/.claude` + `~/.codex` credential seeds. Ollama stays on host (no GPU passthrough yet) — rebound to `0.0.0.0:11434` and reached from the pod via a `Service ollama` + manual `Endpoints` → `192.168.1.163:11434`. Pod talks to `http://ollama.llmgw:11434`.

Source of truth for the migration lives in `docs/k3s-migration/`:
- [k3s-migration/01-PLAN.md](k3s-migration/01-PLAN.md) — detailed phase-by-phase plan with manifests
- [k3s-migration/02-K3S_REFERENCE.md](k3s-migration/02-K3S_REFERENCE.md) — cluster context: what's deployed, conventions, common ops
- [k3s-migration/03-SESSION_MEMO.md](k3s-migration/03-SESSION_MEMO.md) — locked decisions (storage, networking, CI/CD shape)

**Key locked decisions** (from session memo):
- **Storage**: PVC + SQLite (`better-sqlite3`) replaces JSON files for credential cache + validation report. First-boot migration imports the legacy JSON files if present, then ignores them.
- **CI**: GHA on PR runs `test:fast` only (no live Ollama in CI). Full `npm test` stays the pre-merge local gate. Main branch builds + pushes to GHCR + commits SHA bump to `arch-infra` via fine-grained PAT (`ARCH_INFRA_TOKEN`).
- **CD**: ArgoCD pulls arch-infra every ~3 min. No webhook (NAT-friendly).
- **Ollama**: rebound early (before app changes ship) so dev iteration uses the same network path as production.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 40 | SQLite storage layer | ✅ Done | `better-sqlite3@12.9.0` + `src/lib/db.ts` exposes `openDb/getDb/setDb` and typed `readCredentialChain/writeCredentialChain/readValidationReport/writeValidationReport`. Schema: `credentials_chain` (provider PK), `model_validation` (model PK), `meta` (validation batch ISO). WAL journal. `src/services/auth.ts` reads/writes Anthropic chain via DB; `src/services/validation.ts` writes the report in a transaction. `src/index.ts` opens the DB + runs `importLegacyJson()` once at startup (idempotent — skips when rows already exist) so existing pods carry forward `anthropic-credentials.json` + `models.json` into the new schema. `LLMGW_DB_PATH` env var added (default `~/.llm-gateway/state.db`). e2e + compatibility test files initialize an in-memory DB in `beforeAll`. **15 new DB tests + 3 new validation tests; 228 unit tests pass total** (`test:fast`). E2e suite green for Ollama-backed tests; 6 codex/gemini failures observed are pre-existing upstream-auth issues unrelated to this task. |
| 41 | Dockerfile hardening | ✅ Done | `deploy/Dockerfile`: transient `apk add --virtual .build python3 make g++` for `better-sqlite3` native compile, paired with `apk del .build` after `npm ci` in the same layer; `USER node` (UID 1000) before `CMD`. Verified: image builds clean; `docker run --rm llmgw:hardened id` → `uid=1000(node) gid=1000(node)`; in-container `require('better-sqlite3')` round-trips a `:memory:` insert/select under UID 1000. Image size 789MB (+~330MB vs pre-SQLite) is `better-sqlite3` build intermediates — multi-stage build is a follow-up, out of scope for task 41. |
| 42 | Helm chart at `deploy/chart/` | ✅ Done | `deploy/chart/{Chart.yaml,values.yaml,.helmignore}` + 7 templates: `_helpers.tpl`, `deployment.yaml` (single-replica + `Recreate` strategy so two pods never race on the SQLite WAL), `service.yaml` (port 80 → targetPort 51277), `ingress.yaml` (Traefik, `llmgw.arch.local`), `pvc.yaml` (1Gi `local-path`), `ollama-service.yaml` (Service + manual `v1/Endpoints` → `192.168.1.163:11434`), `NOTES.txt`. hostMounts RO Directory for `~/.claude` + `~/.codex`; `gemini` mount gated on `hostMounts.gemini.enabled` (off by default). securityContext split into pod-level (`runAsNonRoot/runAsUser/runAsGroup/fsGroup`) and container-level (`allowPrivilegeEscalation: false`, `capabilities: drop ALL`) — `allowPrivilegeEscalation` would be silently dropped at pod level otherwise. Verification: `helm lint deploy/chart/` clean; `helm template` renders 6 resources; `kubectl apply --dry-run=client` validates them all (only warning: v1/Endpoints deprecated in v1.33+, flagged as a follow-up to migrate to EndpointSlice). |
| 43 | GHA + GHCR + arch-infra bump | ✅ Done (workflow shipped; Phase 0 manual steps pending) | `.github/workflows/build.yml`: `test` job (`npm ci` + `npm run lint` + `npm run test:fast`) on PR + main + `workflow_dispatch`; `build-and-deploy` job on main pushes `ghcr.io/autumnfallenwang/llm-gateway:{latest,<sha>}` via BuildKit + GHA layer cache, then clones `arch-infra` and uses `yq -i` to rewrite `apps/llmgw.yaml`'s `image.tag` parameter to `${{ github.sha }}` (more robust than the plan's greedy `sed`). Defensive guards: warn-skip when `ARCH_INFRA_TOKEN` is unset and when `apps/llmgw.yaml` is absent (lets the workflow land before Phase 0 setup and task 45's Application CR). Concurrency group `build-${{ github.ref }}` with `cancel-in-progress: false` serializes back-to-back main pushes so a slow bump never gets killed mid-`git push`. Workflow YAML parses clean; `yq` targeting logic verified locally (Python sim — `image.tag` mutates, siblings untouched). **Still pending (manual UI, owner-only)**: 0.1 create PAT `ARCH_INFRA_TOKEN` (Contents: write on `arch-infra` only); 0.2 add as repo secret in `llm-gateway`; 0.3 after first build, flip GHCR package to public + link to repo with Write role. |
| 44 | Ollama rebind to 0.0.0.0 | ✅ Done | Shipped `deploy/host/ollama-override.conf` (systemd drop-in `Environment="OLLAMA_HOST=0.0.0.0:11434"`) + `deploy/host/README.md` runbook (install / verify / rollback / security note). Owner installed via `sudo install -d … && sudo install -m 644 … && sudo systemctl daemon-reload && sudo systemctl restart ollama`. Verified: `ss -tlnp \| grep 11434` → `*:11434`; in-cluster `kubectl run --rm test-ollama --image=alpine -- wget -qO- http://192.168.1.163:11434/api/tags` returns Ollama's models JSON; compose container's `/v1/models` still returns all 38 models (loopback still works). |
| 45 | arch-infra registration | 🟡 Drafted locally, awaiting commit+push | `~/github/arch-infra/apps/llmgw.yaml` written: ArgoCD `Application` CR, single-source (path `deploy/chart`, targetRevision `main`, helm `releaseName: llmgw` + `valueFiles: [values.yaml]` + parameter `name: image.tag, value: "latest"`), `destination.namespace: llmgw`, `automated.prune+selfHeal`, syncOptions `CreateNamespace=true` + `ServerSideApply=true`. Verified: `kubectl apply --dry-run=client` validates schema; `helm template … --set image.tag=latest` renders all 6 resources with `image: ghcr.io/autumnfallenwang/llm-gateway:latest`. Holding the `git commit + push` to arch-infra until GHA has produced at least one image (else first sync = `ImagePullBackOff` until then). Flip to ✅ Done after the push lands and `kubectl get app llmgw -n argocd` shows `Synced`. |
| 46 | Cutover + retire compose | ⏳ Planned | Push everything → wait for GHA → wait for ArgoCD sync (~3 min, or annotate `argocd.argoproj.io/refresh=normal`). `kubectl get pods -n llmgw` healthy. Add `192.168.1.163 llmgw.arch.local` to `/etc/hosts`. Smoke test: `curl http://llmgw.arch.local/`. Validate: `curl -X POST http://llmgw.arch.local/v1/models/validate`. Verify Loki: `{namespace="llmgw"}` in Grafana. **Then** `docker compose -f deploy/compose.yaml down`, confirm `:51277` free, delete `deploy/llmgw` + `deploy/compose.yaml` (keep `deploy/Dockerfile` — still used by GHA). Optional `deploy/k3s.sh` with kubectl shortcuts. |

**Risks / open questions**:
- **CI test scope**: GHA can't reach a live Ollama, so the build job uses `test:fast` only. The full e2e suite remains a local pre-merge gate (run via `/check` or `npm test`). If an Ollama-touching regression slips through, ArgoCD's selfHeal will still roll the broken image — the validation hit comes from `/v1/models/validate` post-cutover, not from CI. Worth re-evaluating later if we want a live-Ollama test job (self-hosted runner on the Arch box, or a lightweight Ollama sidecar in CI).
- **First-boot data migration**: legacy JSON files (`anthropic-credentials.json`, `models.json`) exist on the host's `~/.llm-gateway` volume; the new pod will mount the same path via PVC. If we keep using the same host directory for the PVC source (or pre-seed the PVC), task 40's first-boot import path runs cleanly. Otherwise we cold-start the validation cache (recoverable but noisy on the first request).
- **Anthropic OAuth chain transfer**: the cache file (`anthropic-credentials.json`) holds a live refresh token. Carrying it forward via the migration import means the new container resumes the existing chain instead of forcing a re-seed from `~/.claude/.credentials.json`. This avoids racing the host `claude` CLI for a fresh token at cutover.

**Out of scope** (deferred):
- Run Ollama in k3s — needs GPU passthrough, separate effort.
- Sealed Secrets — llmgw has no DB password / API key; install when homecal/homenews land.
- Codex / Gemini lazy refresh — same shape as the Anthropic fix from Phase 6, but neither is currently breaking.

## Previous Milestones

Phase 1 backend + streaming + Docker deploy complete. See tasks 1–10 above.
Phase 2 image processing pipeline complete. See tasks 11–20 above.
Phase 3 context window management complete. See tasks 21–23 above.
Phase 4 provider expansion & tooling complete. See tasks 24–27 above.
Phase 5 embeddings support complete. See tasks 28–32 above. New `POST /v1/embeddings` route, per-capability validator dispatch, `embedding_dimensions` on `/v1/models`. Spec doc + POC at `docs/openai-embeddings-spec.md`.
Phase 6 Anthropic auth hotfix complete. See tasks 33–37 above. Container-private credential chain via seed/cache split, lazy refresh + single-flight mutex on the request path.
Phase 7 structured logging complete. See tasks 38–39e above. pino JSON-per-line + per-request access log middleware + Docker log size cap.
