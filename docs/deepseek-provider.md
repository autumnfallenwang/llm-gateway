# DeepSeek provider (Phase 11)

Add DeepSeek's API models to llmgw behind the same OpenAI-compatible API as the Ollama, Claude and GPT models, so the internal apps reach them the same way. Decided and built 2026-11-02 (branch `feat/deepseek`).

DeepSeek is the gateway's first **metered** backend: a static API key paid per token, not an OAuth subscription.

## Facts (checked live, 2026-11-02)

- **The key is all it takes.** A static `sk-…` key, sent as a Bearer token to the fixed `https://api.deepseek.com`. No refresh token, account ID or project; it never expires unless revoked in DeepSeek's console.
- **Where the key lived:** only in `~/.zshrc` (`export DEEPSEEK_API_KEY=…`, mode 644). ccsw's `~/.ccsw/deepseek.json` holds just a `${DEEPSEEK_API_KEY}` reference, expanded from the shell at launch and passed to `claude` against DeepSeek's Anthropic-compatible endpoint. No DeepSeek tool writes a credentials file.
- **The account is prepaid** (`/user/balance` has `topped_up_balance`, `granted_balance`, `total_balance`). An empty balance is HTTP 402 "Insufficient Balance", never a bill.
- **Models.** `GET /models` lists `deepseek-flash` and `deepseek-v4-pro`, the same two pi-ai 1.4's `deepseek` catalog has. ccsw's profile maps Claude's Haiku slot to `deepseek-v4-flash`, which DeepSeek no longer lists.

  | Model | Input | Context / output | $/MTok in / out (cache read) | Reasoning levels (pi-ai) |
  |---|---|---|---|---|
  | `deepseek-flash` | text, image | 1M / 384K | 0.30 / 1.20 (0.006) | low, high, max |
  | `deepseek-v4-pro` | text | 1M / 384K | 1.32 / 3.96 (0.044) | high, max — but DeepSeek takes low too (see decision 4) |

- **pi-ai's `deepseek` provider** runs on its `openai-completions` backend (the one Ollama already uses). It sends `thinking: {type: "disabled"}` unless given a reasoning level, then `thinking: {type: "enabled"}` plus `reasoning_effort`. It adds an empty `reasoning_content` to earlier assistant turns, which DeepSeek's thinking mode is documented to need — though DeepSeek accepted tool follow-ups without it in testing, even after dropping 553 characters of reasoning.
- **Probe through pi-ai, all OK:** plain reply, `temperature`, tool round trips with thinking off and on (assistant turns rebuilt as the gateway rebuilds them, without reasoning), image on `deepseek-flash`, reasoning on `deepseek-v4-pro`, streaming.

## Decisions

1. **pi-ai, not a passthrough proxy.** Being metered changes only the credential, not the routing: Ollama is a plain API and already goes through pi-ai. Through pi-ai, DeepSeek gets everything the gateway does per backend — error mapping, `tool_choice`, `reasoning_effort` with per-model clamping, `delta.reasoning` streaming, validation, the vision fallback, logging — and `/v1/models` gets context window and output limit from the catalog. A passthrough would hand apps DeepSeek's own shape (`reasoning_content`) and skip all of it. Fields the gateway doesn't take yet (`response_format`, `stop`, `top_p`, …) get added to the gateway once, for every model.
2. **The key lives in one host file: `~/.deepseek/api_key`** — plain text, mode 600, in a mode-700 directory. It is the single source of truth: `~/.zshrc` exports `DEEPSEEK_API_KEY` by reading it (so ccsw keeps working), and the gateway reads it through `DEEPSEEK_CREDENTIALS_PATH`, with the chart mounting `~/.deepseek` read-only like `~/.claude` and `~/.codex`. It shares the Codex loader: read at boot, re-read when the file changes, so rotating the key is editing one file, no restart. No file, no DeepSeek models.
   - The key never refreshes, so the reason the other two are host files (host tools rewrite them) doesn't apply. It's a host file for consistency and one copy.
   - Rejected: a Kubernetes Secret (a second copy, made by hand outside GitOps, a restart to rotate); the key in chart values (git).
3. **Access stays open on the LAN**, like every other model. The prepaid balance caps the worst case. A 402 becomes 429 `insufficient_quota` instead of a 500. Client authentication would be its own change, for every model.
4. **Thinking is off by default.** Apps opt in with `reasoning_effort`, moved to the nearest level each model has; `none` keeps it off. *Corrected 2026-11-04:* DeepSeek's `reasoning_effort` is `none`/`low`/`high`/`max` on **both** models (it maps `minimal` to `low` and `medium`/`xhigh` to `high` itself), but pi-ai lists only `high`/`max` for `deepseek-v4-pro`, so `low` used to go out as `high`. `src/lib/pi.ts` (`THINKING_LEVELS`) adds `low`; `test:deepseek-poc` checks that `low` reaches DeepSeek.
5. **Both models, IDs as DeepSeek lists them**, `owned_by: "deepseek"`.
6. **Images:** `deepseek-flash` takes them directly. `deepseek-v4-pro` (text only) has them described by `deepseek-flash` (`VISION_FALLBACK_DEEPSEEK`; changed 2026-11-04, from the general chain's local `qwen3-vl`): the same family, as Claude has Haiku and GPT has `gpt-6-luna`, well under a tenth of a cent per image, paid once per image with the description cache, and no 12 GB model loaded on the GPU. `VISION_FALLBACK_DEEPSEEK=""` goes back to the general chain.
7. **No embeddings** (DeepSeek has none): `/v1/embeddings` answers 501 `provider_unsupported`, as for Claude and GPT.
8. **Live tests are opt-in** (`npm run test:deepseek-poc`), so ordinary runs spend nothing. The only automatic spend is model validation, a few tokens per model.
9. **Deploy order:** `~/.deepseek` must exist on the host before the merge — the chart mounts it as a hostPath `Directory`, and the pod won't start without it.

**Found while building** (live, 2026-11-02): DeepSeek takes `tool_choice: "required"` and a named tool (offered alone with `required`) — but **not while thinking** (400 "Thinking mode does not support this tool_choice"). A forced `tool_choice` therefore turns DeepSeek's thinking off, as it does Claude's. Errors come through pi-ai as `<status>: {json}` (a bad key is `401: {"message":"Authentication Fails…"}`).

## Work

| # | Task | Status |
|---|---|---|
| 58 | This doc + backlog entries | ✅ |
| 59 | `~/.deepseek/api_key` (700/600) from the existing key; `~/.zshrc` reads it, so the key is no longer in the dotfile | ✅ |
| 60 | Config + auth: `DEEPSEEK_CREDENTIALS_PATH`; the Codex file loader generalized into a shared `HostFileCredential` (`ensureHostCredentialsFresh`) | ✅ |
| 61 | Registry + pi.ts: `deepseek` models, `reasoning_effort` on the `openai-completions` backend | ✅ |
| 62 | Completion: 402 → 429 `insufficient_quota`; a forced `tool_choice` turns thinking off | ✅ |
| 63 | Chart: `~/.deepseek` mount + path | ✅ |
| 64 | Tests: unit (307 fast pass) + `npm run test:deepseek-poc` 14/14 live | ✅ |
| 65 | Docs (CLAUDE.md, error spec, API description, progress), PR, deploy, verify on the cluster | see progress.md |

## Not in scope (backlog)

- Ollama models all register `reasoning: false`, so `reasoning_effort` is dropped even for ones that think (`qwen3:30b`).
- Non-streaming responses don't return reasoning text (only streaming's `delta.reasoning`).
- Client authentication for the gateway.
