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

## POC Log

Empirical probe against local Ollama on 2026-05-07, ollama running at `http://localhost:11434`. Three embedders pulled: `bge-m3:latest`, `qwen3-embedding:0.6b`, `nomic-embed-text:latest`. All commands run via `curl`; response shapes inspected with `jq`.

### Single-string input — happy path

| Model | HTTP | Latency | `data[0].embedding` length | `usage.prompt_tokens` |
|---|---|---|---|---|
| `bge-m3:latest` | 200 | warm | **1024** | 5 |
| `qwen3-embedding:0.6b` | 200 | warm | **1024** | 3 |
| `nomic-embed-text:latest` | 200 | warm | **768** | 4 |

Response shape verified verbatim: `{ object: "list", data: [{ object: "embedding", index: 0, embedding: [...] }], model, usage: { prompt_tokens, total_tokens } }`. **Byte-for-byte OpenAI-compatible** for all three. Dimensions match the table in "Constraints".

### Batch input — `input: ["alpha","beta","gamma"]` against bge-m3

```
HTTP 200
data_count: 3, indices: [0,1,2], dims: [1024,1024,1024]
usage: { prompt_tokens: 10, total_tokens: 10 }
```

One upstream request → three vectors in input order. `usage.prompt_tokens` is the **sum** across inputs, not per-input.

### `encoding_format: "base64"` — bge-m3

```
HTTP 200, embedding_type: "string", embedding_len: 5464
```

Vector arrives as a base64 string. `5464` chars decodes to ~4096 bytes = 1024 × float32 — confirms little-endian float32 layout per spec.

### `dimensions: 512` — bge-m3

```
HTTP 200, dim: 512
```

**Divergence from the OpenAI spec.** OpenAI documents `dimensions` as honored only by `text-embedding-3-*` models, but **Ollama honors it for bge-m3** (and presumably any embedder that supports truncation). Behavior: Matryoshka-style head truncation. Useful — we don't need to special-case which models accept the param. Just pass through; if a model doesn't support it, Ollama returns its own error.

### Error path — unknown model

```bash
curl -X POST .../v1/embeddings -d '{"model":"nonexistent-model-xyz","input":"oops"}'
# HTTP 404
{ "error": {
    "message": "model \"nonexistent-model-xyz\" not found, try pulling it first",
    "type": "not_found_error",
    "param": null,
    "code": null
} }
```

**Two divergences from our chat-completions error envelope:**
- `type: "not_found_error"` — chat completions use `invalid_request_error` for `model_not_found`. Ollama uses a distinct type.
- `code: null` — chat completions return `code: "model_not_found"`. Ollama returns null.

**Gateway implication:** when our route catches Ollama's 404, we should **rewrap** to match our chat-completions envelope (`type: "invalid_request_error"`, `code: "model_not_found"`) for consistency across endpoints. Don't passthrough verbatim. The error rewrap is the only translation step in an otherwise pure passthrough.

But actually, we won't get here in practice — our gateway resolves the model from its own registry before forwarding. An unknown model returns 404 at our route level, never reaches Ollama. This case matters only if a model is pulled from Ollama after the gateway started but never re-registered. Edge case worth handling but not the hot path.

### Edge cases

| Input | HTTP | Notes |
|---|---|---|
| `input: ""` (empty string) | **200** | Returns a real 1024-dim vector with `prompt_tokens: 2`. Ollama is permissive — does not match the OpenAI spec's "cannot be an empty string" wording. We pass through. |
| `input: []` (empty array) | **400** `invalid_request_error` "invalid input" | ✅ matches OpenAI behavior |
| `input: [1212, 318, 257, ...]` (token IDs) | **400** `invalid_request_error` "invalid input type" | ✅ matches Ollama's documented "no token-array support" |

### Conclusions

1. **Pure passthrough is viable** for `model`, `input` (string + array), `encoding_format`, `dimensions`, `user`. No format translation needed.
2. **Error rewrap is the only translator step** — Ollama uses `not_found_error` and null `code` on 404; our gateway should normalize that to `invalid_request_error` + `model_not_found` for envelope consistency. But this only fires for the rare in-flight model rename case.
3. **`dimensions` works on bge-m3** — broader than the OpenAI spec implies. Don't gate it.
4. **Empty string is permissive** in Ollama. We don't pre-validate; let Ollama decide.
5. **All three local embedders are healthy** — match expected dimensions and respond in <1s warm. Ready to be the e2e test fixtures.

The spec contract is now empirically verified for the Ollama path. Implementation can proceed against it.
