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

**Retired in Phase 8**: under GitOps the rebuild/wait/validate steps belong to GHA + ArgoCD, not a host CLI. Replaced by `.github/dependabot.yml` — weekly PRs for npm + Docker base + GHA actions, pi-ai grouped on its own so new model IDs land in a focused PR. CI gates merges; push triggers GHA + ArgoCD; manual validate via `POST http://llmgw.arch.local/v1/models/validate` post-deploy if you want fresh status numbers.

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
