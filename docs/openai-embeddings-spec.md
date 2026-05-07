# OpenAI Embeddings API Specification

Source: https://platform.openai.com/docs/api-reference/embeddings — schema reproduced from `openai/openai-openapi` (`CreateEmbeddingRequest` / `CreateEmbeddingResponse`, `Embedding` object).

This is the canonical reference for `POST /v1/embeddings` as our gateway exposes it. Implementation must round-trip cleanly with any OpenAI-compatible client SDK (`openai-python`, `openai-node`, LangChain, LlamaIndex). The "Gateway Decisions" section at the end records llmgw-specific routing and behavior choices.

## Endpoint

```
POST https://api.openai.com/v1/embeddings
```

Creates an embedding vector representing the input text. Embeddings are static — there is no streaming response and no `stream` parameter. A single request may submit a batch of inputs and receives one embedding per input, indexed in input order.

---

## Request Body

### Required

| Parameter | Type | Description |
|---|---|---|
| `model` | string | Model ID. OpenAI: `text-embedding-3-small` (1536-dim), `text-embedding-3-large` (3072-dim), `text-embedding-ada-002` (1536-dim, legacy). Any string is accepted by the schema; provider-side validation determines whether it resolves. |
| `input` | string \| string[] \| integer[] \| integer[][] | Text to embed. **One** of: a single string, an array of strings (batch), an array of token IDs (single pre-tokenized), or an array of arrays of token IDs (batch pre-tokenized). Cannot be empty string; arrays capped at **2048 items**; per-input length capped at the model's max input tokens (8192 for ada-002). |

### Optional

| Parameter | Type | Default | Description |
|---|---|---|---|
| `encoding_format` | enum: `"float"` \| `"base64"` | `"float"` | Output format for the vectors. `"base64"` returns each vector as a base64-encoded little-endian float32 byte string instead of a JSON array — ~4× more compact on the wire. |
| `dimensions` | integer | (model default) | Truncate vectors to N dimensions. Only honored by `text-embedding-3-*` models; ignored or rejected by older / non-OpenAI models. Used for storing in pgvector columns smaller than the model's native size. |
| `user` | string | – | Stable end-user identifier for OpenAI's abuse-monitoring telemetry. No semantic effect on the embedding itself. |

---

## Response Object

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0023064255, -0.009327292, /* … */, -0.0028842222]
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 5,
    "total_tokens": 5
  }
}
```

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `object` | const `"list"` | Always `"list"`. |
| `data` | `Embedding[]` | One entry per input, in input order. |
| `model` | string | The actual model that produced the vectors (may include version suffix even if the request used a base name). |
| `usage` | object | Always present; see below. |

### `Embedding` object

| Field | Type | Description |
|---|---|---|
| `object` | const `"embedding"` | Always `"embedding"`. |
| `index` | integer | 0-based position matching the input array. For a single-string input, always `0`. |
| `embedding` | number[] \| string | Float array when `encoding_format: "float"`; base64 string when `"base64"`. Dimension is model- and `dimensions`-dependent. |

### `usage` object

| Field | Type | Description |
|---|---|---|
| `prompt_tokens` | integer | Tokens consumed across all inputs. |
| `total_tokens` | integer | Same as `prompt_tokens` for embeddings (no completion). Both fields required. |

---

## Error Envelope

Embeddings reuse the same error shape as chat completions (see [openai-error-spec.md](openai-error-spec.md)):

```json
{
  "error": {
    "message": "Model 'foo' not found",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

| Status | When |
|---|---|
| `400` | Invalid request (missing/wrong field, empty input, exceeds 2048 items, exceeds model token limit, invalid `encoding_format`) |
| `401` | Auth failure (gateway returns this from upstream OpenAI; gateway-side auth is OAuth and never surfaces here) |
| `404` | Model not registered in this gateway |
| `429` | Upstream rate limit |
| `500` | Unclassified upstream / gateway error |
| `501` | Provider doesn't offer embeddings (Anthropic, Codex, Gemini — see Gateway Decisions) |

---

## Constraints

- Single-input string max length: model-dependent, typically 8192 tokens (ada-002). `text-embedding-3-*` also 8192.
- Batch input array: max **2048 items**.
- No streaming; `stream: true` is not a documented parameter for this endpoint and should be rejected as `invalid_request_error`.
- Vector dimensions (typical):
  - `text-embedding-3-small`: 1536 (truncatable via `dimensions`)
  - `text-embedding-3-large`: 3072 (truncatable)
  - `text-embedding-ada-002`: 1536 (fixed)
  - `bge-m3`: 1024 (fixed)
  - `qwen3-embedding:0.6b`: 1024 (fixed)
  - `nomic-embed-text`: 768 (fixed)

---

## Example Requests

### Single string input

```bash
curl -X POST http://localhost:51277/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "bge-m3:latest",
    "input": "The quick brown fox jumped over the lazy dog"
  }'
```

### Batch input

```bash
curl -X POST http://localhost:51277/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "bge-m3:latest",
    "input": ["alpha", "beta", "gamma"]
  }'
```

Response has three entries in `data[]`, in submission order (`index: 0, 1, 2`).

### Compact transport via base64

```bash
curl -X POST http://localhost:51277/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "bge-m3:latest",
    "input": "compact me",
    "encoding_format": "base64"
  }'
```

`data[0].embedding` is a base64 string instead of a float array. Decode as little-endian float32.

### Truncated dimensions (OpenAI 3-series only)

```bash
curl -X POST https://api.openai.com/v1/embeddings \
  -H 'Authorization: Bearer $OPENAI_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "text-embedding-3-small",
    "input": "test",
    "dimensions": 256
  }'
```

Returns a 256-dim vector instead of 1536.

---

## Provider Behavior Matrix

| Provider | OpenAI `/v1/embeddings` support | Notes |
|---|---|---|
| **OpenAI** | ✅ Native | The reference implementation. All fields supported. |
| **Ollama** | ✅ Compatible | Source: `ollama/ollama/docs/api/openai-compatibility.mdx`. Supports `model`, `input` (string + array), `encoding_format`, `dimensions`. **Does not** support: `user`, array-of-tokens, array-of-token-arrays. Response is byte-for-byte the OpenAI shape. |
| **Anthropic** | ❌ No embeddings API | Anthropic does not offer embeddings; they recommend Voyage AI. |
| **OpenAI Codex (ChatGPT OAuth)** | ❌ Not exposed | OAuth path (`pi-ai`) only surfaces chat models. OpenAI's embedding models require API-key auth, not ChatGPT OAuth. |
| **Google Gemini CLI (OAuth)** | ❌ Not exposed | Same — `text-embedding-004` exists on Google's API-key path but not the Gemini-CLI OAuth path. |

---

## Gateway Decisions

Choices specific to llmgw's implementation. Pinned here so they're not re-litigated during the route work.

### Routing

Dispatch by `resolved.provider` (which derives from `owned_by` in the registry):

- `provider === "ollama"` → **passthrough** to `${OLLAMA_BASE_URL}/v1/embeddings`. Forward request body verbatim, return upstream JSON verbatim. Same `Content-Type: application/json`.
- `provider === "openai"` *(future, not yet wired)* → passthrough to `https://api.openai.com/v1/embeddings` with the configured API key.
- `provider === "anthropic" | "codex" | "gemini"` → **501 Not Implemented** with `provider_unsupported` error code. Body example:
  ```json
  { "error": { "message": "Provider 'anthropic' does not offer an embeddings API. Use an Ollama or OpenAI embedding model.", "type": "invalid_request_error", "param": null, "code": "provider_unsupported" } }
  ```
- Unknown model → **404** with `model_not_found` (same envelope as chat completions).

### Capability gate

The route must reject requests where `resolved.capability !== "embedding"` for Ollama models, since chat-only Ollama models will return errors from upstream anyway. Returning `400 invalid_request_error` early is more useful than a confusing upstream 5xx. Fielded as: *"Model 'X' is a chat model. Use POST /v1/chat/completions instead."*

Mirror gate on chat completions: requests where `resolved.capability === "embedding"` against `/v1/chat/completions` should likewise 400 instead of crashing inside pi-ai.

### Passthrough behavior

- `model`, `input`, `encoding_format`, `dimensions` — forwarded unchanged.
- `user` — forwarded but Ollama ignores it; harmless.
- Token-ID inputs (`integer[]` / `integer[][]`) — Ollama doesn't support them. We pass through; Ollama returns its own 400. We don't pre-validate to keep the path one-line.
- Batch input (array of strings) — supported, single passthrough request.
- No request mutation. No `num_ctx` injection (unlike chat completions — embedders use their own context budget).
- Response forwarded verbatim. We do **not** rewrite the `model` field even though Ollama may echo the resolved canonical name — the response should reflect what the model actually answered to.

### What we do *not* implement

- **No format translation.** Ollama already speaks OpenAI shape; we only wrap with our error envelope on transport failures.
- **No streaming.** Embeddings don't stream by spec; reject `stream: true` if a client accidentally sends it.
- **No retries / no rate-limit absorption.** If upstream returns 429, we return 429 verbatim.
- **No batching across requests.** One client request → one upstream request.
- **No usage normalization.** Ollama returns the same `prompt_tokens` / `total_tokens` shape; if a future provider returns something different we'll add a translator then.

### Validator dispatch (Phase 5 task 30)

`/v1/models/validate` currently POSTs chat completions to every model, producing false-positive `error` for embedders. The fix:

```ts
if (resolved.capability === "embedding") {
  const result = await createEmbedding(resolved, { model: id, input: "test" });
  // assert result.data[0].embedding.length > 0; record dim in status_detail
} else {
  // existing chat-completions probe
}
```

Status detail format for embedders: `dim=1024` (or whatever vector length came back). Lets `/v1/models` consumers validate `vector(N)` column dimensions at boot via the optional `embedding_dimensions` field (task 31).

### Optional: `embedding_dimensions` on `/v1/models`

Once the validator records dimensions, mirror the value out as `embedding_dimensions: number` on `ModelObjectSchema`. Optional field, present only after a successful validation. Non-embedding models omit it entirely.

---

## POC Log (filled in by task 29b)

This section is reserved for the empirical probe against local Ollama. Task 29b will run real `curl` commands against `bge-m3:latest`, `qwen3-embedding:0.6b`, and `nomic-embed-text:latest`, and append:

- Exact request and response bytes for single + batch input.
- Confirmed dimensions per model.
- Latency on warm vs cold model load.
- Error response format on bad model name and oversized input.
- Any divergence from this spec (none expected, but we record what we see, not what we hope).

Until that section is filled in, this doc is a research-derived contract; after task 29b it becomes a verified one.
