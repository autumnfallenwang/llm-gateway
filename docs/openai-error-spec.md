# OpenAI Error Response Specification

Sources: OpenAI API docs, community threads, SDK source

---

## Error Response Structure

Every error from the OpenAI API returns this JSON shape:

```json
{
  "error": {
    "message": "Human-readable description of the error",
    "type": "invalid_request_error",
    "param": "temperature",
    "code": "invalid_value"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Human-readable explanation |
| `type` | string | Error category (see table below) |
| `param` | string \| null | Which request parameter caused the error, if applicable |
| `code` | string \| null | Machine-readable error code, if applicable |

---

## HTTP Status → Error Type Mapping

| HTTP Status | `type` | When |
|-------------|--------|------|
| 400 | `invalid_request_error` | Malformed request, missing/invalid params, unsupported features |
| 401 | `authentication_error` | Missing or invalid API key |
| 403 | `permission_error` | Valid key but no access to the requested resource |
| 404 | `not_found_error` | Model or resource doesn't exist |
| 429 | `rate_limit_error` | Rate limited or quota exceeded |
| 500 | `server_error` | Internal server error |
| 503 | `server_error` | Service overloaded / temporarily unavailable |

---

## Known `code` Values

These are the machine-readable `code` strings observed in OpenAI error responses:

| `code` | HTTP | `type` | Meaning |
|--------|------|--------|---------|
| `null` | 400 | `invalid_request_error` | Generic validation error (missing field, wrong type) |
| `model_not_found` | 404 | `not_found_error` | Requested model doesn't exist |
| `context_length_exceeded` | 400 | `invalid_request_error` | Prompt + completion exceeds model context window |
| `rate_limit_exceeded` | 429 | `rate_limit_error` | Too many requests in time window |
| `insufficient_quota` | 429 | `rate_limit_error` | Billing quota exhausted |
| `invalid_api_key` | 401 | `authentication_error` | API key is invalid or revoked |
| `string_above_max_length` | 400 | `invalid_request_error` | A string parameter exceeds max allowed length |

### Gateway-specific `code` Values

The gateway emits these additional codes that aren't in OpenAI's vocabulary but follow the same envelope shape. They surface gateway-specific routing decisions:

| `code` | HTTP | `type` | Meaning | Surface |
|--------|------|--------|---------|---------|
| `vision_fallback_failed` | 502 | `server_error` | All vision fallback models exhausted | `/v1/chat/completions` (Phase 2) |
| `anthropic_auth_failed` | 500 | `server_error` | Container could not refresh Anthropic OAuth | `/v1/chat/completions` (Phase 6) |
| `provider_unsupported` | 501 | `invalid_request_error` | Provider does not offer this endpoint (e.g. Anthropic embeddings) | `/v1/embeddings` (Phase 5) |
| `wrong_capability` | 400 | `invalid_request_error` | Embedding model used at chat endpoint, or chat model used at embeddings endpoint | both routes (Phase 5) |
| `invalid_input` | 400 | `invalid_request_error` | Upstream Ollama rejected the input (e.g. empty array, token-array form) | `/v1/embeddings` (Phase 5) |

Note: OpenAI's error codes are not exhaustively documented. The `code` field is often `null` for simple validation errors. New codes may appear as the API evolves.

---

## Gateway Error Conditions (Phase 1)

These are all error scenarios our gateway needs to handle, mapped to the OpenAI format:

### Validation Errors (400)

| Condition | `message` (example) | `type` | `param` | `code` |
|-----------|---------------------|--------|---------|--------|
| Malformed JSON body | `"Could not parse request body"` | `invalid_request_error` | `null` | `null` |
| Missing `model` | `"Missing required field: model"` | `invalid_request_error` | `model` | `null` |
| Empty model string | `"String must contain at least 1 character(s)"` | `invalid_request_error` | `model` | `null` |
| Missing `messages` | `"Missing required field: messages"` | `invalid_request_error` | `messages` | `null` |
| Empty `messages` array | `"Array must contain at least 1 element(s)"` | `invalid_request_error` | `messages` | `null` |
| Invalid message role | `"Invalid enum value"` | `invalid_request_error` | `messages[0].role` | `null` |
| `temperature` out of range | `"Number must be less than or equal to 2"` | `invalid_request_error` | `temperature` | `null` |
| `max_tokens` not positive | `"Number must be greater than 0"` | `invalid_request_error` | `max_tokens` | `null` |
| `stream=true` (unsupported) | `"Streaming is not supported yet"` | `invalid_request_error` | `stream` | `null` |

### Not Found Errors (404)

| Condition | `message` (example) | `type` | `param` | `code` |
|-----------|---------------------|--------|---------|--------|
| Unknown model | `"The model 'foo' does not exist"` | `not_found_error` | `model` | `model_not_found` |

### Backend Errors (500/502)

| Condition | `message` (example) | `type` | `param` | `code` |
|-----------|---------------------|--------|---------|--------|
| pi-ai call fails | `"Backend error: <detail>"` | `server_error` | `null` | `null` |
| Ollama unreachable | `"Backend unavailable: ollama"` | `server_error` | `null` | `null` |
| Unexpected error | `"Internal server error"` | `server_error` | `null` | `null` |

### Phase 3: Context overflow

| Condition | `message` (example) | `type` | `param` | `code` |
|-----------|---------------------|--------|---------|--------|
| Prompt exceeds model context | `"prompt is too long: 250000 tokens > 200000 maximum context length"` | `invalid_request_error` | `null` | `context_length_exceeded` |

### Phase 5: Embeddings (`/v1/embeddings`)

| Condition | HTTP | `message` (example) | `type` | `param` | `code` |
|-----------|------|---------------------|--------|---------|--------|
| Anthropic / Codex / Gemini model | 501 | `"Provider 'anthropic' does not offer an embeddings API. Use an Ollama or OpenAI embedding model."` | `invalid_request_error` | `null` | `provider_unsupported` |
| Chat model used at `/v1/embeddings` | 400 | `"Model 'qwen3:30b' is a chat model. Use POST /v1/chat/completions instead."` | `invalid_request_error` | `null` | `wrong_capability` |
| Embedding model used at `/v1/chat/completions` | 400 | `"Model 'bge-m3:latest' is an embedding model. Use POST /v1/embeddings instead."` | `invalid_request_error` | `model` | `wrong_capability` |
| Empty array input | 400 | `"invalid input"` | `invalid_request_error` | `null` | `invalid_input` |
| Token-array input (unsupported) | 400 | `"invalid input type"` | `invalid_request_error` | `null` | `invalid_input` |
| Unknown model at `/v1/embeddings` | 404 | `"Model 'foo' not found"` | `invalid_request_error` | `model` | `model_not_found` |

Note on the upstream-Ollama 404 path: Ollama's native error envelope uses `type: "not_found_error"` and `code: null`. The gateway **rewraps** this to `type: "invalid_request_error"` + `code: "model_not_found"` for envelope consistency with `/v1/chat/completions`. See `docs/openai-embeddings-spec.md` "POC Log" §"Error path — unknown model".

---

## Implementation status

The action items below were captured in Phase 1; all are now implemented:

- [x] `param` field added to `ErrorResponseSchema` (`src/schemas/error.ts`)
- [x] `defaultHook` in `app.ts` populates `param` from the first Zod issue's path
- [x] Streaming validation errors include `param: "stream"` when applicable
- [x] Model-not-found errors use `type: "invalid_request_error"`, `code: "model_not_found"`, `param: "model"`
- [x] Tests assert `param` is present (`tests/app.test.ts`, `tests/embeddings.test.ts`)

The current schema matches OpenAI's envelope verbatim:

```typescript
z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string().nullable(),
  }),
})
```
