# Gateway Development Plan - Phase 1

> **Historical doc.** This is the original Phase 1 plan from when the gateway was first built; everything below describes the v0.1 minimum viable shape. The gateway has since added streaming, vision (Phase 2), context window management (Phase 3), Gemini + tooling (Phase 4), embeddings (Phase 5), and container-private OAuth (Phase 6).
>
> For **current state**: see [progress.md](progress.md) for the live task tracker, or `GET /openapi.json` / `/docs` for the live API surface (currently `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`, `/v1/models/validate`).

## Goal

A local REST API that accepts OpenAI-compatible requests and routes to multiple backends (Ollama, Anthropic, Codex) via pi-ai.

---

## Tech Stack

| Concern | Tool | Why |
|---|---|---|
| HTTP framework | **Hono** | Fast, typed, SSE built-in |
| Validation + Types | **Zod** | Single source of truth for schemas |
| OpenAPI docs | **@hono/zod-openapi** + **@hono/swagger-ui** | Auto-generated from Zod schemas |
| Linting + Formatting | **Biome** | One tool, zero config, fast |
| Testing | **Vitest** | Native TS/ESM, Hono `app.request()` |
| Runtime | **Node.js** + **tsx** | Already using tsx in poc-oauth |
| LLM SDK | **@mariozechner/pi-ai** | Unified interface for all backends |

---

## Phase 1 Scope: Minimum Viable Gateway

### Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/chat/completions` | POST | Chat completion (non-streaming) |
| `/v1/models` | GET | List available models |
| `/openapi.json` | GET | OpenAPI 3.1 spec (auto-generated) |
| `/docs` | GET | Swagger UI |

### Request Schema (Zod-defined)

| Parameter | Type | Required | Zod Constraint | Notes |
|---|---|---|---|---|
| `model` | string | Yes | `z.string().min(1)` | Maps to pi-ai model lookup |
| `messages` | array | Yes | `z.array(MessageSchema).min(1)` | Roles: `system`, `user`, `assistant` |
| `temperature` | number | No | `z.number().min(0).max(2).optional()` | Pass to pi-ai StreamOptions |
| `max_tokens` | number | No | `z.number().int().positive().optional()` | Pass to pi-ai as maxTokens |
| `stream` | boolean | No | `z.boolean().optional().default(false)` | Phase 1: non-streaming only, return error if true |

### Response (Phase 1)

```json
{
  "id": "chatcmpl-<timestamp>",
  "object": "chat.completion",
  "created": <unix_seconds>,
  "model": "<model_id>",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<text>"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### Backends (Phase 1)

| Backend | Auth | How |
|---|---|---|
| Ollama (local) | No key needed (pass `"ollama"`) | Custom Model object, api: `openai-completions` |
| Anthropic | OAuth from `~/.claude/.credentials.json` | `getModel("anthropic", id)` + `getOAuthApiKey()` |
| Codex | JWT from `~/.codex/auth.json` | `getModel("openai-codex", id)` + access_token |

### Model Resolution

Client sends `model` string in request. Gateway resolves it:

1. Check if model exists in pi-ai `getModel("anthropic", model)` → use Anthropic
2. Check if model exists in pi-ai `getModel("openai-codex", model)` → use Codex
3. Check if model matches Ollama models via `fetch("http://localhost:11434/v1/models")` → build custom Model object
4. If none match → return 404 error

### Translation: OpenAI Request → pi-ai

```
OpenAI request.messages  →  split system prompt out → pi-ai Context { systemPrompt, messages }
OpenAI request.max_tokens  →  pi-ai options.maxTokens
OpenAI request.temperature  →  pi-ai options.temperature
```

### Translation: pi-ai Response → OpenAI

```
pi-ai result.content (filter type=text, join)  →  choices[0].message.content
pi-ai result.stopReason  →  choices[0].finish_reason  (stop→stop, length→length, toolUse→tool_calls)
pi-ai result.usage.input  →  usage.prompt_tokens
pi-ai result.usage.output  →  usage.completion_tokens
pi-ai result.usage.totalTokens  →  usage.total_tokens
pi-ai result.timestamp  →  created (ms → seconds)
```

---

## Dev Tasks

### 1. Project setup
- Create new project directory `gateway/`
- `package.json` with `type: "module"`
- Dependencies:
  - **Runtime**: `hono`, `@hono/node-server`, `@hono/zod-openapi`, `@hono/swagger-ui`, `zod`, `@mariozechner/pi-ai`
  - **Dev**: `typescript`, `tsx`, `vitest`, `@biomejs/biome`
- `tsconfig.json` - strict mode, ESM
- `biome.json` - formatter + linter config
- `vitest.config.ts`
- Project structure:
  ```
  gateway/
  ├── src/
  │   ├── app.ts            # Hono app (routes, middleware)
  │   ├── index.ts           # Entry point (@hono/node-server)
  │   ├── schemas/
  │   │   ├── chat.ts        # Zod schemas for /v1/chat/completions
  │   │   └── models.ts      # Zod schemas for /v1/models
  │   ├── routes/
  │   │   ├── chat.ts        # Chat completion route handler
  │   │   └── models.ts      # Models list route handler
  │   ├── services/
  │   │   ├── auth.ts        # Load credentials (Anthropic OAuth, Codex JWT)
  │   │   ├── registry.ts    # Model registry (pi-ai + Ollama discovery)
  │   │   └── completion.ts  # Translation layer (OpenAI ↔ pi-ai)
  │   └── lib/
  │       └── ollama.ts      # Ollama model builder (custom Model object)
  ├── tests/
  │   ├── chat.test.ts       # /v1/chat/completions tests
  │   └── models.test.ts     # /v1/models tests
  ├── package.json
  ├── tsconfig.json
  ├── biome.json
  └── vitest.config.ts
  ```

### 2. Zod schemas
- Define `MessageSchema`, `ChatCompletionRequestSchema` in `src/schemas/chat.ts`
- Define `ChatCompletionResponseSchema` (response validation + OpenAPI docs)
- Define `ModelsResponseSchema` in `src/schemas/models.ts`
- All OpenAPI metadata (descriptions, examples) embedded in schemas

### 3. Auth module (`src/services/auth.ts`)
- Load Anthropic OAuth credentials from `~/.claude/.credentials.json`
- Load Codex JWT from `~/.codex/auth.json`
- Cache API keys, refresh when expired

### 4. Model registry (`src/services/registry.ts`)
- On startup: fetch Ollama models from `http://localhost:11434/v1/models`
- On startup: load Anthropic + Codex models from pi-ai `getModels()`
- Expose combined list for `GET /v1/models`
- `resolveModel(modelId)` → returns pi-ai Model + provider info

### 5. Completion service (`src/services/completion.ts`)
- Parse validated OpenAI request → pi-ai `Context` + `StreamOptions`
- Extract system prompt from messages
- Convert messages to pi-ai format (UserMessage, AssistantMessage)
- Call `complete(model, context, options)` with correct API key
- Convert pi-ai `AssistantMessage` → OpenAI response JSON
- Map `stopReason` → `finish_reason`, usage fields, generate id/created

### 6. Routes (`src/routes/`)
- `POST /v1/chat/completions` → Zod-validated, OpenAPI-documented
- `GET /v1/models` → model list from registry
- Error handling (400 validation errors from Zod, 404 model not found, 500 backend errors)

### 7. App + Server (`src/app.ts`, `src/index.ts`)
- Hono OpenAPI app with `@hono/zod-openapi`
- Swagger UI at `/docs`
- OpenAPI spec at `/openapi.json`
- CORS middleware (for browser clients)
- `@hono/node-server` entry point on port 8080

### 8. Tests
- Unit tests with Vitest using Hono `app.request()`
- Validation tests: malformed body, missing fields, out-of-range values → 400
- Model resolution tests: known models → 200, unknown → 404
- Response shape tests: verify OpenAI-compatible structure
- Integration tests (manual): curl commands + OpenAI SDK

---

## Out of Scope (Phase 1)

- Streaming (SSE)
- `top_p`, `stop`, `frequency_penalty`, `presence_penalty` (use `onPayload` later)
- Tool calling / function calling
- `response_format` (JSON mode)
- `reasoning_effort`
- Image inputs
- Token refresh retry logic
- Rate limiting
- Auth on gateway itself (local-only, no inbound auth needed)
- Database / persistence (stateless translation gateway)
- Multiple Ollama hosts

---

## Test Plan

### Vitest (automated)

```typescript
// tests/chat.test.ts
import { describe, it, expect } from 'vitest'
import app from '../src/app'

describe('POST /v1/chat/completions', () => {
  it('rejects missing model', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects empty messages', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:30b', messages: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects temperature out of range', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:30b',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 5,
      }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects stream=true in phase 1', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:30b',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /v1/models', () => {
  it('returns model list', async () => {
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.object).toBe('list')
    expect(Array.isArray(json.data)).toBe(true)
  })
})
```

### Manual curl tests

```bash
# List models
curl http://localhost:8080/v1/models

# Ollama
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3:30b","messages":[{"role":"user","content":"Say hi"}],"max_tokens":50}'

# Anthropic
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Say hi"}],"max_tokens":50}'

# Codex
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.1","messages":[{"role":"user","content":"Say hi"}],"max_tokens":50}'

# System prompt
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3:30b","messages":[{"role":"system","content":"You are a pirate"},{"role":"user","content":"Say hi"}],"max_tokens":100}'

# Multi-turn
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"My name is Aaron"},{"role":"assistant","content":"Nice to meet you!"},{"role":"user","content":"What is my name?"}],"max_tokens":50}'

# Unsupported model → 404
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"nonexistent","messages":[{"role":"user","content":"hi"}]}'

# Stream=true → 400 (not supported in phase 1)
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3:30b","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Swagger docs
curl http://localhost:8080/docs
curl http://localhost:8080/openapi.json
```

### Verify with OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: "dummy",
});

const response = await client.chat.completions.create({
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "What is 2+2?" }],
  max_tokens: 50,
});

console.log(response.choices[0].message.content);
```
