# Ollama OpenAI Compatibility Specification

Source: https://docs.ollama.com/api/openai-compatibility

---

## Supported Endpoints

| Endpoint | Status |
|---|---|
| `POST /v1/chat/completions` | Supported |
| `POST /v1/completions` | Supported |
| `GET /v1/models` | Supported |
| `GET /v1/models/{model}` | Supported |
| `POST /v1/embeddings` | Supported |
| `POST /v1/images/generations` | Experimental |
| `POST /v1/responses` | Supported (v0.13.3+) |

---

## POST /v1/chat/completions

### Supported Parameters

| Parameter | Type | Supported |
|---|---|---|
| `model` | string | Yes (required) |
| `messages` | array | Yes (text, base64 images, content part arrays) |
| `temperature` | number | Yes |
| `top_p` | number | Yes |
| `max_tokens` | number | Yes |
| `stop` | string/array | Yes |
| `frequency_penalty` | number | Yes |
| `presence_penalty` | number | Yes |
| `stream` | boolean | Yes |
| `stream_options` | object | Yes (`include_usage`) |
| `response_format` | object | Yes (JSON mode) |
| `seed` | number | Yes |
| `tools` | array | Yes (function calling) |

### NOT Supported Parameters

| Parameter | Status |
|---|---|
| `tool_choice` | Not supported |
| `logit_bias` | Not supported |
| `logprobs` | Not supported |
| `top_logprobs` | Not supported |
| `user` | Not supported |
| `n` | Not supported |
| `max_completion_tokens` | Not supported |
| `reasoning_effort` | Not supported |
| `verbosity` | Not supported |
| `parallel_tool_calls` | Not supported |
| `audio` / `modalities` | Not supported |
| `web_search_options` | Not supported |
| `prediction` | Not supported |
| `metadata` | Not supported |
| `store` | Not supported |
| `service_tier` | Not supported |
| `safety_identifier` | Not supported |
| `prompt_cache_key` | Not supported |
| Image URLs | Not supported (base64 only) |

---

## GET /v1/models

### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3:30b",
      "object": "model",
      "created": 1700000000,
      "owned_by": "library"
    }
  ]
}
```

Notes:
- `created` = last model modification time
- `owned_by` = always `"library"`

---

## Key Differences from Real OpenAI API

1. Base URL: `http://localhost:11434/v1/` instead of `https://api.openai.com/v1`
2. API key: required in header but ignored (any value works, typically `"ollama"`)
3. Images: only base64-encoded, no URL support
4. Context size: cannot be set via API, requires custom Modelfile
5. Models must be pre-pulled with `ollama pull`
6. Unsupported parameters are silently ignored (no error)

---

## Comparison: OpenAI Spec vs Ollama Support vs Gateway Priority

| Parameter | OpenAI | Ollama | pi-ai | Gateway Priority | Gateway |
|---|---|---|---|---|---|
| `model` | Required | ✅ Supported | ✅ Via Model object | Must have | ✅ Supported |
| `messages` | Required | ✅ Supported | ✅ Via Context | Must have | ✅ Supported |
| `temperature` | Optional (default 1) | ✅ Supported | ✅ StreamOptions | Must have | ✅ Supported |
| `max_tokens` | Optional (deprecated) | ✅ Supported | ✅ maxTokens | Must have | ✅ Supported |
| `max_completion_tokens` | Optional (new) | ❌ Not supported | ✅ maxTokens | Must have (map to max_tokens) | ✅ Supported (mapped to `max_tokens`) |
| `stream` | Optional (default false) | ✅ Supported | ✅ Streaming API | Must have | ✅ Supported |
| `top_p` | Optional (default 1) | ✅ Supported | ❌ Not exposed | Should have | Ignored |
| `stop` | Optional | ✅ Supported | ❌ Not exposed | Should have | Ignored |
| `stream_options` | Optional | ✅ Supported | ❌ Not exposed | Should have | Ignored |
| `frequency_penalty` | Optional (default 0) | ✅ Supported | ❌ Not exposed | Should have | Ignored |
| `presence_penalty` | Optional (default 0) | ✅ Supported | ❌ Not exposed | Should have | Ignored |
| `tools` | Optional | ✅ Supported | ✅ Via Context.tools | Nice to have | Ignored |
| `tool_choice` | Optional | ❌ Not supported | ✅ toolChoice | Nice to have | Ignored |
| `response_format` | Optional | ✅ Supported (JSON mode) | ❌ Not exposed | Nice to have | Ignored |
| `seed` | Optional (deprecated) | ✅ Supported | ❌ Not exposed | Nice to have | Ignored |
| `reasoning_effort` | Optional (default medium) | ❌ Not supported | ✅ reasoning | Nice to have | Ignored |
| `n` | Optional (default 1) | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `logprobs` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `top_logprobs` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `logit_bias` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `parallel_tool_calls` | Optional (default true) | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `user` | Optional (deprecated) | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `audio` / `modalities` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `web_search_options` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `prediction` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `metadata` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `store` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `service_tier` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `safety_identifier` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `prompt_cache_key` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |
| `verbosity` | Optional | ❌ Not supported | ❌ Not supported | Ignore | Ignored |

---

## Response Comparison: OpenAI vs Ollama vs pi-ai

### Non-streaming Response

| Field | OpenAI | Ollama | pi-ai (AssistantMessage) | Gateway |
|---|---|---|---|---|
| `id` | `"chatcmpl-xxx"` | ✅ `"chatcmpl-xxx"` | ❌ Not provided (gateway must generate) | ✅ Present |
| `object` | `"chat.completion"` | ✅ `"chat.completion"` | ❌ Not provided (gateway must add) | ✅ Present |
| `created` | Unix timestamp (seconds) | ✅ Unix timestamp | ✅ `timestamp` (milliseconds, need to convert) | ✅ Present |
| `model` | Model ID | ✅ Model ID | ✅ `model` | ✅ Present |
| `choices` | Array | ✅ Array | ❌ No choices wrapper (single result) | ✅ Present |
| `choices[].index` | integer | ✅ integer | ❌ Not provided (always 0) | ✅ Present |
| `choices[].message.role` | `"assistant"` | ✅ `"assistant"` | ✅ `role: "assistant"` | ✅ Present |
| `choices[].message.content` | string | ✅ string | ✅ `content[].text` (need to join text blocks) | ✅ Present |
| `choices[].message.refusal` | string or null | ❌ Not present | ❌ Not provided | ❌ Not present |
| `choices[].message.annotations` | array | ❌ Not present | ❌ Not provided | ❌ Not present |
| `choices[].message.tool_calls` | array | ✅ When tools used | ✅ `content[].type === "toolCall"` (need to convert) | ✅ Present |
| `choices[].logprobs` | object or null | ❌ Not present | ❌ Not provided | ❌ Not present |
| `choices[].finish_reason` | string | ✅ `"stop"`, `"length"` | ✅ `stopReason` (need to map: `"stop"`→`"stop"`, `"length"`→`"length"`, `"toolUse"`→`"tool_calls"`, `"error"`→`"content_filter"`) | ✅ Present |
| `usage.prompt_tokens` | integer | ✅ integer | ✅ `usage.input` | ✅ Present |
| `usage.completion_tokens` | integer | ✅ integer | ✅ `usage.output` | ✅ Present |
| `usage.total_tokens` | integer | ✅ integer | ✅ `usage.totalTokens` | ✅ Present |
| `usage.prompt_tokens_details` | object | ❌ Not present | ⚠️ Partial: `usage.cacheRead`, `usage.cacheWrite` (can build details object) | ❌ Not present |
| `usage.completion_tokens_details` | object | ❌ Not present | ❌ Not provided | ❌ Not present |
| `service_tier` | string | ❌ Not present | ❌ Not provided | ❌ Not present |
| `system_fingerprint` | string | ✅ `"fp_ollama"` | ❌ Not provided | ❌ Not present |

### pi-ai AssistantMessage fields → OpenAI mapping

| pi-ai field | Type | Maps to OpenAI |
|---|---|---|
| `role` | `"assistant"` | `choices[0].message.role` |
| `content` | `(TextContent \| ThinkingContent \| ToolCall)[]` | See below |
| `content[].type === "text"` | `{ type: "text", text: string }` | `choices[0].message.content` (join all text blocks) |
| `content[].type === "thinking"` | `{ type: "thinking", thinking: string }` | ❌ No OpenAI equivalent (drop or ignore) |
| `content[].type === "toolCall"` | `{ type: "toolCall", id, name, arguments }` | `choices[0].message.tool_calls[]` |
| `api` | string | ❌ Internal, not needed in output |
| `provider` | string | ❌ Internal, not needed in output |
| `model` | string | `model` |
| `usage.input` | integer | `usage.prompt_tokens` |
| `usage.output` | integer | `usage.completion_tokens` |
| `usage.totalTokens` | integer | `usage.total_tokens` |
| `usage.cacheRead` | integer | `usage.prompt_tokens_details.cached_tokens` |
| `usage.cacheWrite` | integer | ❌ No direct OpenAI equivalent |
| `usage.cost` | object | ❌ No OpenAI equivalent (gateway-only info) |
| `stopReason` | string | `choices[0].finish_reason` (needs mapping) |
| `errorMessage` | string or undefined | ❌ No direct mapping (use for error responses) |
| `timestamp` | number (ms) | `created` (convert: `Math.floor(timestamp / 1000)`) |

### stopReason mapping

| pi-ai `stopReason` | OpenAI `finish_reason` |
|---|---|
| `"stop"` | `"stop"` |
| `"length"` | `"length"` |
| `"toolUse"` | `"tool_calls"` |
| `"error"` | `"content_filter"` |
| `"aborted"` | `"stop"` |

### Streaming Response

| Field | OpenAI | Ollama | pi-ai (AssistantMessageEvent) | Gateway |
|---|---|---|---|---|
| `object` | `"chat.completion.chunk"` | ✅ `"chat.completion.chunk"` | ❌ Not provided (gateway must add) | ✅ Present |
| `choices[].delta.role` | `"assistant"` (first chunk) | ✅ | ✅ `type: "start"` event | ✅ Present |
| `choices[].delta.content` | string (token) | ✅ | ✅ `type: "text_delta"`, `delta` field | ✅ Present |
| `choices[].delta.tool_calls` | array | ✅ When tools used | ✅ `type: "toolcall_delta"` / `"toolcall_end"` | ✅ Present |
| `choices[].delta.reasoning` | string (reasoning models) | ✅ | ✅ `type: "thinking_delta"`, `delta` field | ✅ Present |
| `choices[].finish_reason` | string (last chunk) | ✅ | ✅ `type: "done"`, `reason` field | ✅ Present |
| `data: [DONE]` | End of stream | ✅ | ✅ Stream `.end()` | ✅ Present |

### pi-ai stream events → OpenAI SSE mapping

| pi-ai event | Maps to OpenAI SSE |
|---|---|
| `{ type: "start" }` | `data: {"choices":[{"delta":{"role":"assistant"}}]}` |
| `{ type: "text_delta", delta: "Hello" }` | `data: {"choices":[{"delta":{"content":"Hello"}}]}` |
| `{ type: "thinking_delta", delta: "..." }` | `data: {"choices":[{"delta":{"reasoning":"..."}}]}` |
| `{ type: "toolcall_start" }` | `data: {"choices":[{"delta":{"tool_calls":[{"id":"...","function":{"name":"..."}}]}}]}` |
| `{ type: "toolcall_delta", delta: "..." }` | `data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"..."}}]}}]}` |
| `{ type: "done", reason: "stop" }` | `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` then `data: [DONE]` |
| `{ type: "error" }` | Error response or `data: [DONE]` |

### Ollama Extra Fields (not in OpenAI spec)

| Field | Description |
|---|---|
| `choices[].message.reasoning` | Reasoning/thinking content from thinking models (e.g., qwen3) |
| `choices[].delta.reasoning` | Streaming reasoning content |
| `system_fingerprint` | Always `"fp_ollama"` |

### Ollama Missing Fields (present in OpenAI)

| Field | Description |
|---|---|
| `choices[].message.refusal` | Content refusal message |
| `choices[].message.annotations` | Response annotations |
| `usage.prompt_tokens_details` | Detailed prompt token breakdown (cached, audio) |
| `usage.completion_tokens_details` | Detailed completion token breakdown (reasoning, audio, prediction) |
| `service_tier` | Processing tier info |
