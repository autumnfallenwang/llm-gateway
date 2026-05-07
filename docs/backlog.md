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

## 3. `llmgw update` — full dependency update pipeline

**What**: Add an `update` subcommand to the `llmgw` CLI
**Flow**: `npm outdated` → `npm update` → `npm test` → if pass: `llmgw rebuild`, if fail: rollback `package.json` + `package-lock.json`
**Scope**: All deps, not just pi-ai. Small dep count makes full update safe.
**Why**: pi-ai updates bring new Anthropic/Codex models. Other deps bring security patches and bug fixes. One command to stay current with a safety net.

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

**Bugs**:
- `POST /v1/embeddings` returns 404 — route does not exist. Blocks homenews semantic search (Phase 15) end-to-end; `articles.embedding` is NULL across the board.
- `/v1/models/validate` mis-tests embedding models by POSTing chat completions, producing false-positive `error` status for `bge-m3:latest`, `qwen3-embedding:0.6b`, `nomic-embed-text:latest`. Smoking gun: 9-78ms failures (chat-completions error path, not real inference).

**Fix scope**:
1. Add `POST /v1/embeddings` route — OpenAI schema, route by `owned_by`:
   - `ollama` → passthrough to `${OLLAMA_BASE_URL}/v1/embeddings` (already OpenAI-compatible)
   - `openai` → passthrough to `https://api.openai.com/v1/embeddings`
   - `anthropic`, `openai-codex`, `google-gemini-cli` → 501 with `provider_unsupported` error
2. Tag models with `capability: "chat" | "embedding" | "vision"` at registry discovery time. Use Ollama `/api/show` (already called for vision detection) — embedders show empty `TEMPLATE` and bert/embedding family. Hardcode for non-Ollama providers.
3. Validator: route by capability — embedders POST to `/v1/embeddings` with `input: "test"`, assert `data[0].embedding.length > 0`, record dim in `status_detail`.
4. (Optional) Expose `embedding_dimensions` in `/v1/models` so consumers can validate vector column dim at boot.

**Why**: homenews (and any future consumer) needs embeddings through the same OpenAI-compatible seam as chat — no side channels, no per-task provider adapters. Ollama already speaks the OpenAI embedding schema, so it's a byte-for-byte passthrough.

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
