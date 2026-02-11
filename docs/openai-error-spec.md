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

### Future Consideration (not Phase 1)

| Condition | HTTP | `type` | `code` |
|-----------|------|--------|--------|
| Context too long for model | 400 | `invalid_request_error` | `context_length_exceeded` |
| Auth token expired / missing (if gateway adds auth) | 401 | `authentication_error` | `invalid_api_key` |
| Backend rate limited | 429 | `rate_limit_error` | `rate_limit_exceeded` |

---

## Comparison: What We Have vs What We Need

### Current `ErrorResponseSchema`

```typescript
z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().nullable(),
  }),
})
```

### What OpenAI Actually Returns

```typescript
z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),  // ← MISSING from our schema
    code: z.string().nullable(),
  }),
})
```

### Action Items

- [ ] Add `param` field to `ErrorResponseSchema`
- [ ] Update `defaultHook` in `app.ts` to populate `param` from Zod issue path
- [ ] Update stream-not-supported error to include `param: "stream"`
- [ ] Update model-not-found error (task #4) to use `type: "not_found_error"`, `code: "model_not_found"`
- [ ] Update tests to assert `param` field is present
