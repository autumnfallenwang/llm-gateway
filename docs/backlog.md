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
