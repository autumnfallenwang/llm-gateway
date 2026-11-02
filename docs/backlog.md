# Backlog

## 1. Replace llava with qwen3-vl:8b as default vision fallback

**Current**: `VISION_FALLBACK_OLLAMA` defaults to `llava`
**Change**: Default to `qwen3-vl:8b` in `src/config.ts`
**Why**: qwen3-vl:8b has vastly better vision quality (DocVQA ~96 vs llava ~70s), supports video, 256K context, only 6.1 GB

## 2. Enrich /v1/models with validation status

**Current**: `/v1/models` filters out failed models — clients only see healthy ones
**Change**: Return ALL registered models with status fields:
- `status`: `"ok"` | `"error"` | `"unknown"`
- `status_detail`: error message (null when ok/unknown)
- `validated_at`: ISO timestamp of last validation (null if never validated)

**Why**: Hiding broken models loses information. Clients should see full picture and decide themselves. Completion endpoint already allows requests to any registered model regardless of validation status.

## 3. `llmgw update` — full dependency update pipeline ✅ Done 2026-05-06, retired in Phase 8

**What**: `update` subcommand on the `llmgw` CLI.
**Flow**: `ncu -u` (cross caret/tilde caps) → `npm install` → `npm test` (gate, rolls back package.json + lockfile on failure) → `npm version patch` → rebuild container → wait for ready → `POST /v1/models/validate` → commit + push.
**Scope**: All deps, not just pi-ai. Single command, fully automatic downstream — type one thing, walk away.
**Why**: pi-ai updates bring new Anthropic/Codex models, but their `^0.x` caret means `npm update` alone gets stuck at the minor cap. `ncu -u` rewrites the spec so we follow latest. Test gate prevents broken updates from reaching the deployed container; auto-validate ensures `/v1/models` reflects upstream availability without a separate manual call.

**Retired in Phase 8**: under GitOps the rebuild/wait/validate steps belong to GHA + ArgoCD, not a host CLI. Replaced by `.github/dependabot.yml` — weekly PRs for npm + Docker base + GHA actions, pi-ai grouped on its own so new model IDs land in a focused PR. CI gates merges; push triggers GHA + ArgoCD; manual validate via `POST http://llmgw.arch.internal/v1/models/validate` post-deploy if you want fresh status numbers.

## 4. Add Gemini provider support

**What**: Add Google Gemini as a fourth backend via pi-ai's `"google-gemini-cli"` provider
**Auth**: Read Gemini CLI credentials (OAuth via Google account, same pattern as Anthropic/Codex)
**Changes**:
- `src/services/auth.ts` — Gemini credential loading
- `src/config.ts` — `GEMINI_CREDENTIALS_PATH` env var
- `src/services/registry.ts` — `geminiModels` array, `getModels("google-gemini-cli")`
- `src/services/completion.ts` — handle any Gemini-specific quirks
- Vision fallback config — add Gemini option
- Tests — unit + e2e

**Models available**: gemini-2.0-flash, gemini-2.5-flash, gemini-2.5-pro, gemini-3-flash-preview, gemini-3-pro-preview
**Why**: Gemini Pro plan already paid for. pi-ai already supports it. Same integration pattern as existing providers.

**Tested**: pi-ai `complete()` with `google-gemini-cli` provider works. Key findings:
- Credentials at `~/.gemini/oauth_creds.json` (created by `gemini` CLI after `npm i -g @google/gemini-cli && gemini`)
- Auth is more complex than Anthropic/Codex: need OAuth access token + projectId
- projectId discovered via `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`
- pi-ai expects `apiKey` as `JSON.stringify({ token: accessToken, projectId })`
- Token refresh uses Google OAuth2 endpoint with Gemini CLI's client_id/secret
- `gemini-2.5-flash` responded correctly in smoke test

## 5. Embeddings hotfix — add `POST /v1/embeddings` + per-capability validation

**Source**: [llmgw-embeddings-hotfix.md](llmgw-embeddings-hotfix.md) — handoff doc from a homenews debugging session.

**Status**: half done. Task 28 (registry-side capability tagging) shipped in commit `3b8fb30`. Tasks 29-32 (route, validator, tests, dimensions field) are still ⏳ — see `docs/progress.md` Phase 5 for the full task table.

**Bugs**:
- `POST /v1/embeddings` returns 404 — route does not exist. Blocks homenews semantic search (Phase 15) end-to-end; `articles.embedding` is NULL across the board.
- `/v1/models/validate` mis-tests embedding models by POSTing chat completions, producing false-positive `error` status for `bge-m3:latest`, `qwen3-embedding:0.6b`, `nomic-embed-text:latest`. Smoking gun: 9-78ms failures (chat-completions error path, not real inference).

**Workflow** (matches the precedent set by chat completions + vision: research → spec doc → implementation → tests):
1. **Research** OpenAI `/v1/embeddings` standard, write `docs/openai-embeddings-spec.md` as the canonical reference for request/response/error format. (Task 29a)
2. **POC** against local Ollama embedders to confirm passthrough viability and record exact response bytes/dimensions. Append to spec doc. (Task 29b)
3. **Implement** schemas + route + service per the spec. (Task 29c)
4. **Per-capability validator dispatch** so embedders stop showing as false-positive errors. (Task 30)
5. **Optional `embedding_dimensions`** field on `/v1/models`. (Task 31)
6. **Unit + e2e tests** mirroring spec examples. Swagger `/docs` updates automatically via `@hono/zod-openapi`. (Tasks 32a, 32b)

**Why**: homenews (and any future consumer) needs embeddings through the same OpenAI-compatible seam as chat — no side channels, no per-task provider adapters. Ollama already speaks the OpenAI embedding schema, so it's a byte-for-byte passthrough. The spec doc step is non-negotiable: it's why we have `openai-chat-completions-spec.md` for the chat path, and skipping it last time is exactly why Phase 5 stalled at task 28 with no clear handoff between metadata work and route work.

## 6. Anthropic auth hotfix — container-private credential chain + lazy refresh

**Source**: [llmgw-anthropic-auth-hotfix.md](llmgw-anthropic-auth-hotfix.md) — full handoff with root-cause analysis and architecture decision.

**Bugs**:
- Production `POST /v1/chat/completions` against Anthropic models returns `Connection error.` because the container is using a stale access token.
- `deploy/compose.yaml` single-file bind-mount (`~/.claude/.credentials.json:...:ro`) pins to an inode that the host's `claude` CLI rotates via atomic rename. Container never sees new bytes after first start.
- `src/services/auth.ts` `loadAnthropicCredentials()` only re-reads disk; never calls `refreshAnthropicToken()`. The `setInterval` cron in `src/index.ts` fires every 30 min and re-reads the same frozen-inode file — no real OAuth refresh anywhere in the Anthropic path.

**Fix scope**:
1. `deploy/compose.yaml` — switch `~/.claude` and `~/.codex` to **directory** bind-mounts (`:ro`). Reuse the existing `~/.llm-gateway` writable volume for the container's private credential cache.
2. `src/services/auth.ts` — container becomes its own OAuth client. On first start, seed from host file → immediately call `refreshAnthropicToken()` → write to container cache. On subsequent starts, read cache (ignore seed).
3. Replace the `setInterval` cron with **lazy refresh + single-flight mutex** on the request path. Matches what the Claude CLI itself does. Drop `CREDENTIAL_REFRESH_INTERVAL_MS`.
4. Tests — seed-vs-cache bootstrap, mutex deduplication on concurrent expiry, refresh write-through.

**Out of scope (follow-ups)**:
- Codex: same inode-pinning issue but JWT lasts 28 days, not currently broken. Directory mount alone keeps it working; lazy refresh via `refreshOpenAICodexToken` is a follow-up.
- Gemini: already refreshes in-memory, but writes back to the `:ro` host file (silent failure). Follow-up to write to container cache instead.

**Why**: standard OAuth supports multiple independent refresh-token chains per account. The container running its own chain is the right architecture — never touching the host file means we can't break a running `claude` CLI session, and we're not at the mercy of host-side filesystem semantics.

## 7. Structured logging (Phase 7)

**Source**: [structured-logging-spec.md](structured-logging-spec.md) — full contract.

**State**: spec doc done; implementation pending.

**Why**: 29 ad-hoc `console.log/warn/error` calls produce un-structured plaintext. Per-request access logs are entirely missing — when something fails in production, you can't tell which request, with what params, took how long. Universal JSON-per-line output unlocks any modern aggregator (Loki, ELK, Datadog) without app-side changes.

**Scope**:
1. New `src/lib/logger.ts` — single configured `pino` instance with `service`/`version` base fields. `LOG_LEVEL` env var.
2. Migrate all 29 `console.*` sites to typed `log.*` calls (auth ~12, validation ~4, registry/ollama ~3, vision-fallback ~2, server-startup ~2, others ~6).
3. Hono `app.use("*")` middleware emits `event:"http.request"` line per request with `req_id`, `method`, `path`, `status`, `latency_ms`.
4. `deploy/compose.yaml` adds Docker log size cap (`max-size: 10m`, `max-file: 5`) — currently unbounded.
5. Unit tests for logger module + middleware shape.

**Out of scope** (separate later phases): Loki+Promtail+Grafana deployment, Prometheus metrics, OpenTelemetry. App stays portable; observability infrastructure layers on top of stdout via Docker's existing capture.

## 8. Model coverage audit — GPT via ChatGPT Go, Claude upkeep (2026-11-01) ✅ Done 2026-11-01

**Findings**:
- **GPT works on a ChatGPT Go plan, but production serves none.** `npm run test:codex-poc` (`tests/codex-go.poc.test.ts`, opt-in, live) passes 17/17: completion, streaming, system prompt, multi-turn, tool round trip, forced `toolChoice: "required"` (pi-ai level), vision, reasoning effort, `/v1/models/validate`. Go gets 3 models — `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna` — exactly the visible models the Codex backend's `GET /backend-api/codex/models` lists for the account, and all 3 are in pi-ai. The other 6 catalog models answer "not supported when using Codex with a ChatGPT account" (higher plans, or retired). The cluster has `CODEX_ENABLED=false`, so `/v1/models` there has 0 GPT models.
- **Claude is healthy.** All 17 Anthropic IDs validate `ok` in production, and a live sweep of the 14 distinct models × {`temperature`, tool round trip, forced `tool_choice: "required"`} passed 42/42. pi-ai's catalog flags match Anthropic's current per-model rules (temperature rejected, thinking that can't be disabled, forced tool use while thinking).
- **pi-ai 1.4.0** (we're on 1.3.0): drops the retired `gpt-5.3-codex-spark` and `gpt-5.5`; no new models; identical Anthropic catalog; no API changes in what `src/lib/pi.ts` imports.

**Needed to serve GPT on the cluster**:
1. `deploy/chart/values.yaml` — `CODEX_ENABLED: "true"`. The host `~/.codex` mount is already there, and the pod's uid 1000 owns `auth.json`.
2. Codex token lifetime. The gateway reads `auth.json` once at boot, and the access token lasts **10 days** (not 28, as #6 assumed). Decision open:
   - (a) Re-read the host file when the cached token nears expiry (or its mtime changes). The host's VS Code ChatGPT extension keeps it refreshed. Simplest, and no refresh-token conflict; lapses if Codex goes unused on the host for 10 days.
   - (b) A container-private refresh chain through pi-ai's `openaiCodexProvider().auth.oauth` (same shape as `refreshAnthropicToken`). Refresh tokens are single-use, so seeding it from the host file would log the VS Code extension out: give the container its own login (`CODEX_HOME=<dir> codex login`) instead.

   Leaning (a) now, (b) with a dedicated login if lapses bite.

**API correctness**:
3. A model the plan doesn't include returns HTTP 500 `server_error`. Map "not supported when using Codex with a ChatGPT account" to 404 `model_not_found` ([openai-error-spec.md](openai-error-spec.md)).
4. A Claude refusal returns HTTP 500. pi-ai maps `stop_reason: "refusal"` to `stopReason: "error"` (message = `stop_details.explanation`) but keeps `rawStopReason: "refusal"`. Return 200 with `finish_reason: "content_filter"` and `message.refusal` instead — the OpenAI shape. Matters on the classifier-gated models (Fable 5.1, Opus 5.5, Sonnet 5.5).
5. `/v1/models/validate` drops the backend's error: `validation.ts` records only `unexpected stopReason: error`. Include `result.errorMessage` (and update `tests/validation.test.ts`), so plan-limited models say why.
6. Bump pi-ai to 1.4.0, and fix `.github/dependabot.yml`: the pi-ai group still matches `@mariozechner/pi-ai` (now `@earendil-works/pi-ai`), and the npm `open-pull-requests-limit: 5` is already reached (6 open), so no new npm PRs arrive.
7. `claude-sonnet-4-5` (+ `-20250929`) **retires 2026-11-30** and is still in pi-ai 1.4's catalog. Drop retired IDs in `getModels()` (a `RETIRED` set beside `NO_TEMPERATURE`) so `/v1/models` doesn't list dead models; move `tests/pi.test.ts`'s sonnet-4-5 case to another model.
8. Stale model IDs. The vision fallback `gpt-4o-mini` (`VISION_FALLBACK_OPENAI` and the general chain) isn't a model the gateway has → `gpt-6-luna`. `gpt-5.1` (gone) in `tests/e2e.test.ts`, the OpenAPI examples in `src/routes/chat.ts` and `src/config.ts` → `gpt-6-luna`. Optionally `claude-haiku-4-5` → `claude-haiku-5-5` as the Anthropic fallback. Update CLAUDE.md's config table to match.

**Optional — use more of what the models can do**:
9. A `reasoning_effort` request param, mapped to pi-ai's `reasoning`. Today callers can't choose: Codex gets `effort: "none"`; the Claude models pi-ai drives with mid-conversation effort (Fable 5.1, Opus 5/5.5, Sonnet 5.5, Haiku 5.5) are pinned to `high` (the API default on Opus 5.5 and Haiku 5.5 is `medium`); Opus 4.6–4.8 and Sonnet 4.6 never think (pi-ai sends no `thinking`).
10. Forward `tool_choice` to Codex (`withToolChoice` skips it). The backend honours `"required"`; a named function can be pinned the way Anthropic's is.
11. Codex ignores `max_tokens` (pi-ai sends no output limit). Document it in the OpenAPI description.

**Watch**:
- When pi-ai's bundled `@anthropic-ai/sdk` reaches 1.x (now 0.129.0; latest 1.3.0), requests move to API version `2026-10-21`, which rejects `temperature`/`top_p`/`top_k` on every model. Re-check temperature handling on that bump.
- `NO_TEMPERATURE` in `src/lib/pi.ts` is still needed: pi-ai 1.4 hasn't fixed `claude-sonnet-5` / `claude-fable-5`.

**Resolution** (all 11 items, plus one found while fixing them):
- Item 2 went with (a): `ensureCodexFresh()` in `services/auth.ts` re-reads `auth.json` when its mtime changes — on each Codex request, before validation, and before the validate route reloads the registry (so a login that appears after boot registers its models).
- 12\. **The Codex backend rejects `temperature`** ("Unsupported parameter: temperature", live), and pi-ai's Codex backend sends it anyway — so every OpenAI client that sends `temperature` got a 500 from every GPT model. `getModels()` flags all Codex models `supportsTemperature: false`, and `stream()` in `src/lib/pi.ts` drops temperature for any model flagged so.
- `reasoning_effort` maps through `reasoningOptions()` in `src/lib/pi.ts`, which clamps the level with pi-ai's `clampThinkingLevel` and follows its `streamSimple` mapping per API (Codex `reasoningEffort`; Claude adaptive `effort`, or a thinking budget via `adjustMaxTokensForThinking` on Claude 4.5 and older). The vision fallback asks its model for `none`.
- Live: `npm run test:codex-poc` 20/20 (adds temperature, forced `tool_choice` both ways, `reasoning_effort`, the 404, and validation reasons). Full suite: everything passes except the Anthropic e2e cases, which need a Claude login the dev run deliberately doesn't have.
- Not done: the stale Dependabot PRs from May and July (#1–#6, #18–#24) are still open; the raised PR limit just stops them from blocking new ones.

## 9. DeepSeek provider (Phase 11)

**Source**: [deepseek-provider.md](deepseek-provider.md) — facts, decisions, tasks.

DeepSeek's API models (`deepseek-flash`, `deepseek-v4-pro`) through pi-ai's `deepseek` provider, behind the same OpenAI-compatible API. The gateway's first metered backend. Key in one host file, `~/.deepseek/api_key`, read by both the gateway (mounted read-only like `~/.codex`) and `~/.zshrc` (for ccsw). Thinking off unless `reasoning_effort`; open on the LAN with the prepaid balance as the cap; 402 → 429 `insufficient_quota`.

## 10. Reasoning gaps (found 2026-11-02)

- **Ollama models never reason through the gateway.** `src/lib/ollama.ts` registers every Ollama model with `reasoning: false`, so `reasoning_effort` is dropped even for thinking models (`qwen3:30b`, `gpt-oss`). Fix: set `reasoning` from Ollama's `/api/show` capabilities (`thinking`), which the registry already fetches, and check what pi-ai's `openai-completions` backend sends Ollama for a level.
- **Non-streaming responses drop the reasoning text.** `formatResponse` keeps only text blocks; streaming sends thinking as `delta.reasoning`. Add `message.reasoning` (the same field name) for parity.
- **No client authentication.** Anything on the LAN can use every model; with DeepSeek that spends money (capped by the prepaid balance). A bearer token would affect every app, so it's its own change.
