# Context Window Test Results

Direct backend tests bypassing the gateway. Input: `"word " * 300,000` (~1.5MB).

## pi-ai `complete()` Results

### Anthropic (claude-haiku-4-5)

- **contextWindow**: 200,000 | **maxTokens**: 64,000
- **stopReason**: `error`
- **errorMessage**: `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200050 tokens > 200000 maximum"}}`
- **isContextOverflow()**: `true`
- **Behavior**: Rejects request, returns exact token counts in error

### Codex (gpt-5.1-codex-mini)

- **contextWindow**: 272,000 | **maxTokens**: 128,000
- **stopReason**: `error`
- **errorMessage**: `{"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model.","param":"input"}}`
- **isContextOverflow()**: `true`
- **Behavior**: Rejects request with OpenAI-standard `context_length_exceeded` code
- **Note**: Codex Responses API requires `systemPrompt` — without it, fails with `"Instructions are required"` before reaching context check

### Ollama (qwen3:30b via raw `/api/chat`)

- **contextWindow** (model_info): 262,144 | **num_ctx** (runtime default): ~4,096
- **HTTP status**: 200 (no error)
- **prompt_eval_count**: 4,096 (silently truncated)
- **Behavior**: Silently truncates to `num_ctx`, keeps most recent tokens, drops oldest
- **isContextOverflow()**: `false` (undetectable)

### Ollama — exceeding model's actual context_length

- `num_ctx: 32768` (= llava's limit) with 100k input → truncated to 32,768. **No error.**
- `num_ctx: 65536` (beyond llava's 32k limit) → still capped at 32,768. **No error.**
- **Ollama never errors on context overflow.** Always silently truncates regardless of `num_ctx` setting.

## Ollama `num_ctx` VRAM Test (gpt-oss:20b, 24GB GPU)

| num_ctx | Status | VRAM |
|---------|--------|------|
| 4,096 | PASS | ~14GB |
| 32,768 | PASS | ~14.8GB |
| 65,536 | PASS | ~15.6GB |
| 98,304 | PASS | ~16.5GB |
| 128,896 | PASS | ~17.3GB |
| 129,024 | OOM | - |

Model supports 131k but 24GB VRAM limits practical `num_ctx` to ~128k.

## Action Items

### 1. Fix gateway error swallowing

`formatResponse()` in `src/services/completion.ts` maps `stopReason: "error"` to `finish_reason: "stop"` via the `?? "stop"` fallback. This swallows **all** pi-ai errors, not just context overflow — rate limits, auth failures, network errors, etc. Fix: check `result.stopReason === "error"` and throw. Use `isContextOverflow()` to return `context_length_exceeded` (400); fall back to generic `server_error` (500) for other errors. Preserve `result.errorMessage` in the response.

### 2. Add configurable `OLLAMA_NUM_CTX`

Add `OLLAMA_NUM_CTX` env var to `src/config.ts`. Pass it as `num_ctx` in Ollama requests. Default to a sensible value (e.g., 32768). Users set based on their GPU VRAM. This replaces Ollama's wasteful ~4096 default.

### 3. Expose `contextWindow` and `maxTokens` in `/v1/models`

Add non-standard fields to `/v1/models` response. OpenAI spec doesn't include them, but clients need these to manage context intelligently. Data already exists on every `Model` object — just surface it. Won't break OpenAI compatibility (extra fields are ignored by clients that don't use them).

## Unified Error Strategy

**Anthropic & Codex**: Detect `stopReason: "error"` from pi-ai + `isContextOverflow()`. Return unified OpenAI-format error:
```json
{ "error": { "type": "invalid_request_error", "code": "context_length_exceeded", "message": "...", "param": null } }
```

**Ollama**: Cannot detect overflow — Ollama never errors, always truncates silently. Gateway-side token counting is impractical (tokenizers differ per model, images add unknown token costs). Accept this limitation. Clients should use `context_window` from `/v1/models` to manage context themselves.

## Key Findings

1. **Anthropic & Codex** reject overflows with clear errors; pi-ai's `isContextOverflow()` detects both
2. **Ollama** never errors on overflow — silently truncates in all cases, even beyond model's own `context_length`
3. Ollama defaults `num_ctx` to ~4,096 regardless of model capability — wastes 97%+ of available context
4. **Gateway bug**: `formatResponse()` maps `stopReason: "error"` to `finish_reason: "stop"`, swallowing Anthropic/Codex overflow errors
5. **Gateway-side token counting not viable** — different tokenizers per model, unknown image token costs. Not worth the complexity.
