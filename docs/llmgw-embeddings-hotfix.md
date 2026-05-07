# llm-gateway Hotfix: Add `/v1/embeddings` Support

Handoff doc for a hotfix on the `llm-gateway` project. Generated from a debugging session inside the `homenews` project, which consumes llmgw for all model calls.

## TL;DR

- `llm-gateway` v0.3.2 is **missing** the `POST /v1/embeddings` route entirely — returns `404 Not Found` in <1ms.
- The `/v1/models/validate` validator also **mis-tests embedding models** by calling chat-completions against them, which they legitimately refuse. This produces false-positive `error` states for every embedding model.
- Both bugs are visible for: `bge-m3:latest`, `qwen3-embedding:0.6b`, `nomic-embed-text:latest`.
- All three embedders work perfectly against Ollama natively. The gap is entirely in llmgw.
- Fix: add a `POST /v1/embeddings` route that proxies to upstream per `owned_by`, and teach the validator to route embedding-capable models through it. Use the **OpenAI `/v1/embeddings` schema** as the canonical format — Ollama already speaks it, so it's a byte-for-byte passthrough.

## Context: why embeddings matter for homenews

homenews uses embeddings for semantic + hybrid search over articles and user highlights (Phase 15). The pipeline:

1. After analyzing an article, `apps/api/src/services/embed.ts` POSTs to `${LLM_GATEWAY_URL}/v1/embeddings` with `{model, input}`.
2. The returned 1024-dim vector is stored in `articles.embedding vector(1024)` (pgvector, HNSW cosine index).
3. `/search` embeds the query once per request and runs `embedding <=> $query_vec` against the index.

Every embed call in the most recent production run logged `[embed] fail error=404 404 Not Found` — the analysis rows committed fine (best-effort wrapped in try/catch) but `articles.embedding IS NULL` across the board, and semantic search returns empty.

The design principle we want to preserve: **all model calls — chat, instruct, and embeddings — flow through llmgw using OpenAI-compatible formats.** No side channels, no per-task provider adapters in the consuming apps. llmgw is the single model-access seam.

## The OpenAI `/v1/embeddings` schema (the standard to implement)

This is the de-facto unified embeddings format. Ollama, Cohere, Voyage, Mistral, Together, Fireworks, vLLM, and llama.cpp server all implement it. Anthropic is the only major provider that does **not** offer embeddings (they recommend Voyage).

### Request

```json
POST /v1/embeddings
Content-Type: application/json

{
  "model": "bge-m3:latest",
  "input": "Hello world",
  "encoding_format": "float",
  "dimensions": 1024,
  "user": "optional-tracking-id"
}
```

- `input` may be a single `string` or an array of strings (batch).
- `encoding_format` is optional (`"float"` default, `"base64"` for compact transport).
- `dimensions` is optional (truncate output to N dims — only some models support it).
- `user` is optional (tracking hint).

### Response

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0123, -0.0456, ...]
    }
  ],
  "model": "bge-m3:latest",
  "usage": {
    "prompt_tokens": 5,
    "total_tokens": 5
  }
}
```

One `data` entry per input, in input order. Vector dimension is model-dependent (bge-m3 = 1024, nomic-embed-text = 768, OpenAI `text-embedding-3-small` = 1536, etc.).

## Evidence: POC against Ollama directly

Run against `http://localhost:11434` on a machine with all three embedders pulled. Proves the upstream side is healthy and already OpenAI-compatible.

### bge-m3:latest

```
[1] Ollama native   POST /api/embeddings
    ok: dim=1024 sample=[-1.0402, 0.1573, -1.1063]
    HTTP 200 in 19.17s  (first-load; subsequent calls are cached)

[2] Ollama OpenAI   POST /v1/embeddings
    ok: dim=1024 sample=[-0.0410, 0.0062, -0.0436]
    HTTP 200 in 90ms

[3] llmgw           POST /v1/embeddings
    body: 404 Not Found
    HTTP 404 in <1ms    ← no route handler
```

### qwen3-embedding:0.6b

```
[1] Ollama native   POST /api/embeddings
    ok: dim=1024 sample=[0.0039, 0.0152, -0.0109]
    HTTP 200 in 2.99s   (first-load)

[2] Ollama OpenAI   POST /v1/embeddings
    ok: dim=1024 sample=[0.0039, 0.0152, -0.0109]
    HTTP 200 in 60ms

[3] llmgw           POST /v1/embeddings
    body: 404 Not Found
    HTTP 404 in <1ms
```

### nomic-embed-text:latest

```
[1] Ollama native   POST /api/embeddings
    ok: dim=768 sample=[0.5178, 0.1372, -3.7393]
    HTTP 200 in 740ms

[2] Ollama OpenAI   POST /v1/embeddings
    ok: dim=768 sample=[0.0244, 0.0065, -0.1759]
    HTTP 200 in 12ms

[3] llmgw           POST /v1/embeddings
    body: 404 Not Found
    HTTP 404 in <1ms
```

**Observation 1:** All three embedders return correct-dimension vectors on both Ollama transports. The OpenAI-compat endpoint is the right target — identical schema, identical behavior, lower latency (first call slightly slower due to model cold-load).

**Observation 2:** Note the *different* sample values between `/api/embeddings` and `/v1/embeddings` for the same model and same input — Ollama normalizes / re-scales vectors differently between the two paths. For llmgw purposes this doesn't matter because we're exclusively using `/v1/embeddings`, but it's worth knowing: mixing transports would produce incompatible stored vectors.

**Observation 3:** `nomic-embed-text:latest` was **never actually broken** — it has been listed as `status: error` in llmgw for weeks, but it embeds instantly against Ollama. That's a pure validator false positive (see below).

## Evidence: llmgw's current behavior

From `GET /v1/models` after a fresh `llmgw restart` followed by `POST /v1/models/validate`:

```
bge-m3:latest            error    78ms  unexpected stopReason: error
qwen3-embedding:0.6b     error    58ms  unexpected stopReason: error
nomic-embed-text:latest  error     9ms  unexpected stopReason: error
```

Three separate embedding models, three different sizes and architectures, three near-instant failures with the same error. The 9-78ms latency range is the smoking gun: inference against a loaded embedder takes 10-90ms; inference against a cold one takes 700ms-20s. 9ms can only be the gateway calling an endpoint that refuses the request before any model work happens.

Hypothesis: the validator unconditionally POSTs to the chat-completions endpoint. Embedding models have no chat head, so the upstream (Ollama) returns an error immediately. Latency confirms: this is a chat-completions error path, not an embeddings success path.

## Fix checklist

### 1. Add `POST /v1/embeddings` route

New route handler. Accepts the OpenAI schema above. Routes by `owned_by` of the requested model:

- `ollama` → proxy to `http://ollama:11434/v1/embeddings` (or whatever `OLLAMA_BASE_URL` is in llmgw's env). Request and response are already in OpenAI format — this is a transparent passthrough. Preserve `Content-Type`, forward body verbatim, return upstream body verbatim.
- `openai` → proxy to `https://api.openai.com/v1/embeddings` with the configured API key. Again a passthrough.
- `anthropic` → return `501 Not Implemented` with a body like `{"error": {"message": "Anthropic does not offer an embeddings API. Use an Ollama or OpenAI embedding model instead.", "type": "provider_unsupported"}}`. (Future: if/when Voyage AI is plumbed in, route there.)
- `openai-codex` → same 501 or whatever is appropriate; Codex doesn't have embedding models in the current llmgw enumeration.

Error paths should mirror the existing chat-completions error envelope so homenews (and any other consumer) can catch them uniformly.

### 2. Tag models with capability at discovery time

When llmgw enumerates Ollama models, call `POST http://ollama:11434/api/show` with `{"name": "<model>"}` and inspect the response. Ollama exposes capability info — for embedding models the `details` object contains `family: "bert"` (for bge-m3, nomic), `family: "qwen3"` with embedding-specific metadata (for qwen3-embedding), and the model card / modelfile `TEMPLATE` is empty or absent for pure embedders.

Store a new field on the model record: `capability: "chat" | "embedding" | "vision"` (extend as needed). Expose it in `GET /v1/models` response under each model entry so consumers can pick the right ones for the right task.

For non-Ollama providers, hardcode capability based on a known list (OpenAI: `text-embedding-*` → `embedding`, everything else → `chat`; Anthropic: everything → `chat`).

### 3. Fix `/v1/models/validate` per-capability

Current validator (hypothesized) POSTs `/v1/chat/completions` with a tiny prompt to every model. Change it:

- `capability === "chat"` → current behavior (tiny chat completion)
- `capability === "embedding"` → POST to `/v1/embeddings` with `{"model": id, "input": "test"}`, assert `response.data[0].embedding.length > 0`, record dim in the status detail
- `capability === "vision"` → existing behavior or skip

Embedding validation is cheap (10-100ms) so this adds no meaningful load.

### 4. Expose embedding dimension in `/v1/models`

Useful for consumers that need to pre-provision vector columns. Optional but nice:

```json
{
  "id": "bge-m3:latest",
  "owned_by": "ollama",
  "capability": "embedding",
  "embedding_dimensions": 1024,
  "status": "ok",
  ...
}
```

homenews would use this to validate at boot that the configured `embedding_model_name` has the same dimension as the `vector(N)` column, catching misconfig early instead of silently storing zero vectors.

### 5. Optional: embedding-specific settings in llmgw config

If llmgw has a concept of per-provider defaults (max tokens, temperature, etc.), embeddings don't use those. No temperature, no max_tokens, no stop sequences. The config schema for embeddings is roughly: `{base_url, api_key}` and that's it.

## After the hotfix: verification

Consumer-side smoke tests (from homenews, which is your main consumer):

```bash
# 1. Validate all models — embedders should now be "ok"
curl -s -X POST http://localhost:51277/v1/models/validate \
  | jq '.models | to_entries | map(select(.value.status=="ok")) | map(.key)'

# 2. Direct embedding call via llmgw — should succeed with 1024-dim vector
curl -s -X POST http://localhost:51277/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-m3:latest","input":"semantic search test"}' \
  | jq '.data[0].embedding | length'
# expect: 1024

# 3. Batch embedding — array input
curl -s -X POST http://localhost:51277/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-m3:latest","input":["first","second","third"]}' \
  | jq '.data | length'
# expect: 3

# 4. Anthropic model — should 501, not 500 or 404
curl -s -X POST http://localhost:51277/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","input":"x"}' \
  -w '\n%{http_code}\n'
# expect: 501
```

Then on the homenews side:

```bash
# Backfill existing articles + highlights that have embedding IS NULL
pnpm --filter @homenews/api run db:backfill-embeddings

# Trigger semantic search — should return results instead of empty
curl -s 'http://localhost:3001/search?q=alignment&mode=semantic&limit=5' \
  | jq '.results | length'
```

## Appendix: full POC log

Raw log preserved at `/tmp/embed-poc.log` on the homenews machine. Reproduce with:

```bash
LOG=/tmp/embed-poc.log; : > $LOG
for M in bge-m3:latest qwen3-embedding:0.6b nomic-embed-text:latest; do
  echo "=== $M ===" >> $LOG
  echo "[1] ollama /api/embeddings" >> $LOG
  curl -s -w "\nHTTP %{http_code} in %{time_total}s\n" \
    -X POST http://localhost:11434/api/embeddings \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$M\",\"prompt\":\"hello world\"}" >> $LOG
  echo "[2] ollama /v1/embeddings" >> $LOG
  curl -s -w "\nHTTP %{http_code} in %{time_total}s\n" \
    -X POST http://localhost:11434/v1/embeddings \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$M\",\"input\":\"hello world\"}" >> $LOG
  echo "[3] llmgw /v1/embeddings" >> $LOG
  curl -s -w "\nHTTP %{http_code} in %{time_total}s\n" \
    -X POST http://localhost:51277/v1/embeddings \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$M\",\"input\":\"hello world\"}" >> $LOG
  echo >> $LOG
done
cat $LOG
```

## Environment at time of debugging

- OS: Arch Linux, kernel 6.19.11
- Ollama: 0.16.2 → upgraded during session (pre-upgrade couldn't pull `gemma4:26b`)
- llm-gateway: v0.3.2, running in Docker compose (`llmgw` CLI wrapper)
- GPU: RTX 3090, 24GB VRAM, 20GB free at rest
- Ollama models installed: `bge-m3:latest` (1.2GB), `qwen3-embedding:0.6b` (640MB), `nomic-embed-text:latest` (274MB), plus chat models
- Consumer: homenews `apps/api/src/services/embed.ts` using OpenAI Node SDK pointed at `${LLM_GATEWAY_URL}/v1`
