# Model IDs: `provider/model` (Phase 12)

Give every model an ID that can't collide, before the usage-limits work (Phase 13, [usage-limits.md](usage-limits.md)) starts keying data by model. Decided and built 2026-11-02 (branch `feat/model-ids`).

## Problem

The gateway names models by their bare ID (`claude-haiku-5-5`, `qwen3:30b`) and `resolveModel` searched Ollama → Anthropic → Codex → DeepSeek, **taking the first match**. If two providers ever listed the same ID, one model would silently shadow the other, `/v1/models` would list the ID twice, and the validation report (keyed by ID) would mix them.

No collision is possible today — the 36 production IDs are distinct, every Ollama ID carries a `:tag`, no cloud ID does — but the likely future one is **the same model through two providers**: an OpenAI API key next to the Codex subscription (`gpt-6-luna` in both), or Claude through Bedrock / OpenRouter (`claude-opus-5-5`).

## Decisions

1. **No UID.** The unique key already exists: the provider (`owned_by`) plus the model ID. An opaque UID would need a lookup step in every app, make logs and config unreadable, and — to stay stable across restarts — be derived from provider + ID anyway.
2. **`provider/model` always works** — `anthropic/claude-haiku-5-5`, `openai-codex/gpt-6-luna`, `deepseek/deepseek-flash`, `ollama/qwen3:30b`. The prefix is exactly the model's `owned_by`. This is the convention OpenRouter and LiteLLM use.
3. **A bare ID keeps working when one provider has it** — every model today, so no app changes.
4. **A bare ID that two providers share is a 400 `ambiguous_model`** (`param: "model"`) naming the qualified choices — never a silent pick. The registry logs `registry.ambiguous_models` when it loads one.
5. **`/v1/models` lists each model under an ID that resolves to it**: bare when unique, qualified when ambiguous. The validation report and model status are keyed by that listed ID, so colliding models get separate rows.
6. **A slash is a provider prefix only when the prefix is one of ours** (`ollama`, `anthropic`, `openai-codex`, `deepseek`) **and** the rest is that provider's model. Otherwise the whole string is a model ID: Ollama community models already look like `user/model:tag` or `hf.co/user/model`.
7. Responses echo the `model` the request sent, as before. **Backends always get the model's own ID**: pi-ai sends `model.id` for chat, and `/v1/embeddings` (an Ollama pass-through) rewrites `model` to it — found on the cluster after the first deploy, when `ollama/bge-m3:latest` reached Ollama verbatim and 404'd.
8. Config that names a model (the vision fallback chain) takes either form; an ambiguous bare ID there is skipped like a missing one, so use the qualified form.

## Work

| # | Task | Status |
|---|---|---|
| 66 | This doc, [usage-limits.md](usage-limits.md), backlog, progress | ✅ |
| 67 | Registry: one entry list with a listed ID per model; `lookupModel` (found / ambiguous / missing); `resolveModel` on top; `ResolvedModel.id`; `registry.ambiguous_models` warning | ✅ |
| 68 | Routes: 400 `ambiguous_model` on chat and embeddings; credential re-resolves and the vision fallback go by the listed ID | ✅ |
| 69 | Tests: qualified IDs per provider, a real collision (a mock Ollama model named `deepseek-flash`), community `user/model:tag` and `deepseek/coder:7b` names, unknown prefixes, the route 400 (317 fast pass) | ✅ |
| 70 | Docs (CLAUDE.md, error spec, API description, schema descriptions), PR, deploy, verify on the cluster | see progress.md |
