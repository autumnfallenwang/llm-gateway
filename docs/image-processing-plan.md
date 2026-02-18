# Image Processing Plan

## Background

Modern LLMs (GPT-4o, Claude, Gemini) are natively multimodal — they accept image tokens alongside text tokens in a single API call. No separate vision model or OCR layer is needed. The image is base64-encoded, sent as a content part, and the model processes it directly.

However, each provider has different API formats, size limits, and capabilities. Some models don't support vision at all. The gateway's job is to normalize all of this so clients send one format and get consistent behavior regardless of the target provider.

### Research Sources

This plan is informed by studying three open-source projects:

- **OpenCode** (sst/opencode) — always converts images to base64 data URIs, no preprocessing, relies on Vercel AI SDK for provider format conversion
- **Lobe-Chat** (lobehub/lobe-chat) — optional client-side resize (max 2160px, WebP), provider-specific "context builders" for format conversion
- **OpenClaw** (openclaw/openclaw) — the most sophisticated: image preprocessing with `sharp` (resize, compress, EXIF fix, HEIC conversion), vision model fallback for non-vision models, configurable model chains with fallbacks

The gateway design follows OpenClaw's "always own the bytes" principle: regardless of how images arrive (URL or base64), we always resolve to a raw buffer, preprocess uniformly, then route to the provider.

---

## Scope

### In Scope

- Accept OpenAI-compatible image requests (`image_url` content parts)
- Preprocess images (resize, compress, format-convert, EXIF fix)
- Format-convert for each provider's native API
- Vision fallback: route images through a vision model when the target model lacks vision support
- Multiple images per message

### Out of Scope

- Image generation (DALL-E style)
- Image editing (inpainting, outpainting)
- Persistent image storage
- OCR or structured data extraction
- Streaming of partial image descriptions
- Client-side image tools (that's the client app's job)

---

## OpenAI-Compatible Input Format

The gateway accepts the standard OpenAI content array format:

```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What's in this screenshot? Focus on the error message."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQ...",
            "detail": "high"
          }
        }
      ]
    }
  ]
}
```

### Supported `url` Formats

| Format | Example | Gateway Behavior |
|---|---|---|
| Base64 data URI | `data:image/jpeg;base64,/9j/4AAQ...` | Decode to buffer |
| HTTPS URL | `https://example.com/photo.jpg` | Fetch to buffer (with timeout + size cap) |

The text and image parts travel together in the same message. The text part serves as the user's prompt/question about the image. There is no separate "image prompt" field.

### Supported Image Formats

| Format | MIME | Notes |
|---|---|---|
| JPEG | `image/jpeg` | Most common, direct support |
| PNG | `image/png` | Preserve alpha channel when present |
| WebP | `image/webp` | Convert to JPEG/PNG for providers that don't support it |
| GIF | `image/gif` | Pass through without resize (static frame only) |
| HEIC/HEIF | `image/heic`, `image/heif` | iPhone photos — convert to JPEG |

### The `detail` Parameter

OpenAI supports `"high"`, `"low"`, or `"auto"` on `image_url.detail`. This hints at the resolution the model should use:

| Value | Meaning | Gateway Behavior |
|---|---|---|
| `high` | Full resolution (up to 2048px) | Default preprocessing |
| `low` | Thumbnail (512px) | Resize to 512px max side |
| `auto` | Model decides | Treat as `high` |

---

## Architecture: The Pipeline

```
Client sends OpenAI-compatible request
            |
   +--------v---------+
   |   STAGE 1: PARSE  |  Extract image_url parts from content array
   +--------+---------+
            |
   +--------v---------+
   |   STAGE 2: LOAD   |  Resolve all inputs to raw Buffer
   +--------+---------+
            |
   +--------v----------+
   |  STAGE 3: PREPROCESS |  Unified image optimization
   +--------+----------+
            |
   +--------v---------+
   |   STAGE 4: ROUTE  |  Check target model vision capability
   +---+----------+---+
       |          |
  supports    no vision
  vision      support
       |          |
  +----v----+ +---v-----------+
  | STAGE 5A| | STAGE 5B      |
  | FORMAT  | | VISION        |
  | CONVERT | | FALLBACK      |
  +---------+ +---------------+
       |          |
       +----+-----+
            |
   Standard OpenAI response
```

---

## Stage 1: Parse

Extract image content parts from the OpenAI message format.

**Input:** OpenAI-compatible request body

**Processing:**
- Walk `messages[].content` arrays
- Identify parts with `type: "image_url"`
- Preserve text parts and their ordering
- Handle multiple images per message
- Handle mixed text + image messages
- Validate: reject if `image_url.url` is missing or empty

**Output:** List of image references (URL or data URI) with their positions in the message array, plus the `detail` hint if present.

---

## Stage 2: Load

Resolve all image references to raw byte buffers.

**Input:** Image references from Stage 1

**Processing:**

For `data:` URIs:
```
data:image/jpeg;base64,/9j/4AAQ...
  -> extract MIME type: image/jpeg
  -> decode base64 -> Buffer
```

For `https:` URLs:
```
https://example.com/photo.jpg
  -> HTTP GET with:
     - Timeout: 30 seconds
     - Max response size: 20MB
     - SSRF protection: reject private IPs (10.x, 172.16.x, 192.168.x, 127.x)
     - Follow redirects: max 3
  -> Buffer
```

After loading:
- Detect MIME from magic bytes (first 4-16 bytes of buffer), not from URL extension or Content-Type header
- Reject: 0-byte buffers, unsupported MIME types, corrupted files (no valid magic bytes)

**Output:** `{ buffer: Buffer, mime: string }` for each image

**Security:**
- SSRF protection on URL fetches (reject private/internal IPs)
- Size cap on fetches (prevent memory exhaustion)
- Timeout on fetches (prevent hanging)

---

## Stage 3: Preprocess

Unified image optimization pipeline. Every image goes through this regardless of source.

**Input:** Raw buffer + MIME type from Stage 2

**Processing (in order):**

1. **HEIC/HEIF conversion** — Convert Apple formats to JPEG using `sharp`
2. **EXIF orientation fix** — Read EXIF orientation tag, rotate/flip pixels to correct orientation, strip EXIF data
3. **Alpha channel detection** — Check if PNG has transparency
4. **Format decision:**
   - Has alpha → keep as PNG
   - No alpha → convert to JPEG (smaller, faster)
   - GIF → pass through (no resize)
5. **Resize + compress (grid search):**
   - If `detail: "low"` → target max side 512px
   - Otherwise → try resolution × quality combinations until under size cap:
     - Resolutions: [2048, 1536, 1280, 1024, 800] px max side
     - JPEG quality: [80, 70, 60, 50, 40]
     - PNG compression: [6, 7, 8, 9]
   - Pick the first combination that fits under the target provider's size limit
   - If PNG with alpha can't fit → fall back to JPEG (lose transparency)
6. **Re-encode to base64 data URI**

**Output:** `{ dataUri: string, mime: string, sizeBytes: number }` for each image

**Provider Size Limits:**

| Provider | Max Image Size | Max Dimensions |
|---|---|---|
| OpenAI | 20MB | 2048px (short side for high detail) |
| Anthropic | 5MB (base64) | 1568px (long side) |
| Google Gemini | 20MB | No explicit limit |
| Ollama (llava, etc.) | Varies | Varies |

The gateway preprocesses to the **most restrictive limit** of the target provider. Default target: 5MB / 2048px max side (safe for all providers).

**Library:** `sharp` (same as OpenClaw) — handles JPEG, PNG, WebP, HEIC, GIF, EXIF rotation.

---

## Stage 4: Route

Determine whether the target model supports vision.

**Input:** Target model ID from request, preprocessed images from Stage 3

**Processing:**
- Look up model in the gateway's model registry
- Check if model has vision/image capability
- Route to Stage 5A (direct) or Stage 5B (fallback)

**Model vision capability** should be tracked in the model registry. For known models:

| Provider | Vision Models | Non-Vision Models |
|---|---|---|
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-5, gpt-5-mini | gpt-3.5-turbo, o1-mini (text-only) |
| Anthropic | claude-sonnet-4-20250514, claude-opus-4-20250918, claude-haiku-4-5 (all recent Claude models) | Older Claude 2.x models |
| Google | gemini-2.0-flash, gemini-2.5-pro | — |
| Ollama | llava, llama3.2-vision, bakllava | Most text-only models |

For unknown models: attempt direct send, fall back on error.

---

## Stage 5A: Format & Forward (Vision Model)

Convert preprocessed images to the target provider's native API format.

**OpenAI format** (pass through — already in correct format):
```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/jpeg;base64,/9j/...",
    "detail": "high"
  }
}
```

**Anthropic format:**
```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/jpeg",
    "data": "/9j/..."
  }
}
```

**Google Gemini format:**
```json
{
  "inlineData": {
    "mimeType": "image/jpeg",
    "data": "/9j/..."
  }
}
```

**Ollama format** (OpenAI-compatible, same as OpenAI):
```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/jpeg;base64,/9j/..."
  }
}
```

After format conversion, forward the request to the provider and return the standard OpenAI-compatible response.

---

## Stage 5B: Vision Fallback (Non-Vision Model)

When the target model doesn't support images, route through an intermediate vision model to convert images to text descriptions.

**Processing:**

1. **Select vision model** (family-first + general fallback):
   - **Family match**: pick the vision model for the target model's provider family (same-provider affinity, lower latency, consistent billing)
   - **General fallback**: if the family model is unavailable, try models from a general fallback chain
   - Default family models: ollama → `llava`, anthropic → `claude-haiku-4-5`, openai → `gpt-4o-mini`
   - Default general chain: `llava` → `claude-haiku-4-5` → `gpt-4o-mini`

2. **Build vision request:**
   - Use the user's original text as the vision prompt (not a generic "Describe the image")
   - This produces a description relevant to what the user actually asked
   - Send image + user text to the vision model
   - Example: user asks "What's this error?" → vision model sees the image with that context → describes the error specifically

3. **Get text description back**

4. **Replace image parts in the message:**
   - Remove `image_url` content parts
   - Prepend the description as context:
   ```
   [Image Description]
   The screenshot shows a terminal window with a Node.js error: "TypeError: Cannot read properties of undefined (reading 'map')" at line 42 of index.js.

   User's original question: What's this error?
   ```

5. **Forward text-only request** to the target non-vision model

6. **Return standard OpenAI response** (the client doesn't know a vision model was used)

**Configuration** (in `src/config.ts`, all env-var overridable):

```typescript
// Per-family preferred vision model (same-provider affinity)
VISION_FALLBACK_FAMILY: Record<string, string> = {
  ollama: "llava",           // VISION_FALLBACK_OLLAMA
  anthropic: "claude-haiku-4-5",  // VISION_FALLBACK_ANTHROPIC
  openai: "gpt-4o-mini",    // VISION_FALLBACK_OPENAI
};

// General fallback chain if family model unavailable
// VISION_FALLBACK_GENERAL (comma-separated)
VISION_FALLBACK_GENERAL: string[] = ["llava", "claude-haiku-4-5", "gpt-4o-mini"];

VISION_FALLBACK_MAX_DESCRIPTION_CHARS = 1000;  // VISION_FALLBACK_MAX_DESCRIPTION_CHARS
VISION_FALLBACK_TIMEOUT_MS = 30_000;           // VISION_FALLBACK_TIMEOUT_MS
```

**Selection logic:**
1. Look up `VISION_FALLBACK_FAMILY[targetModel.provider]` → try that model first
2. If unavailable, iterate `VISION_FALLBACK_GENERAL` → first available wins
3. If nothing available → return 502 error

---

## Implementation Phases

### Phase 1: Parse + Load + Preprocess + Format Convert (Stage 1-3 + 5A)

The core value — clients can send images and they'll work with any provider.

**New files:**
```
src/
  services/
    image/
      parse.ts          # Extract image parts from OpenAI content arrays
      load.ts           # Resolve data: URIs and https: URLs to buffers
      preprocess.ts     # Resize, compress, EXIF fix, format conversion
      format.ts         # Convert to provider-specific content format
      index.ts          # Orchestrator: parse -> load -> preprocess -> format
  lib/
    mime.ts             # Magic bytes MIME detection
```

**New dependency:** `sharp`

**Schema changes:**
- Update `MessageSchema` in `src/schemas/chat.ts` to accept content as `string | ContentPart[]`
- Add `ContentPartSchema` (text part + image_url part)

**Integration point:**
- In the chat completion route, after Zod validation, before calling pi-ai:
  1. Call image pipeline to process any image parts
  2. Get back provider-formatted content
  3. Pass to existing completion service

### Phase 2: Vision Fallback (Stage 5B)

Adds the ability to send images to non-vision models.

**New files:**
```
src/
  services/
    image/
      fallback.ts       # Vision model selection + description generation
```

**Config changes:**
- Add vision fallback configuration to `src/config.ts`
- Add vision capability flag to model registry entries

---

## Provider Size Limits Reference

| Provider | Max File Size | Max Dimensions | URL Support | Formats |
|---|---|---|---|---|
| OpenAI | 20MB | 2048px (short side) | Yes (server fetches) | JPEG, PNG, GIF, WebP |
| Anthropic | 5MB (base64) | 1568px (long side) | No (base64 only) | JPEG, PNG, GIF, WebP |
| Google Gemini | 20MB (inline) | No explicit limit | Yes (fileData) | JPEG, PNG, GIF, WebP |
| Ollama | Varies by model | Varies | No (base64 only) | JPEG, PNG |

Gateway target: preprocess to **5MB / 2048px** by default (safe for all providers). Provider-specific limits can override this if the target provider supports larger files.

---

## Error Handling

| Error | HTTP Status | Response |
|---|---|---|
| Invalid/empty `image_url.url` | 400 | `"Invalid image URL in content part"` |
| Unsupported image format | 400 | `"Unsupported image format: {mime}"` |
| Image fetch timeout (URL) | 400 | `"Image URL fetch timed out after 30s"` |
| Image fetch too large (URL) | 400 | `"Image exceeds 20MB fetch limit"` |
| SSRF blocked (private IP) | 400 | `"Image URL points to a private network address"` |
| Image preprocessing failed | 500 | `"Failed to process image: {reason}"` |
| Vision fallback failed | 502 | `"Vision model unavailable for image description"` |
| Corrupted/0-byte image | 400 | `"Image data is empty or corrupted"` |

---

## Test Plan

### Unit Tests

```
parse.test.ts
  - Extracts single image from content array
  - Extracts multiple images from one message
  - Preserves text parts alongside images
  - Handles string content (no images) unchanged
  - Rejects missing url field

load.test.ts
  - Decodes data: URI to buffer
  - Detects MIME from magic bytes (JPEG, PNG, WebP, GIF)
  - Rejects invalid base64
  - Rejects 0-byte images
  - Rejects unsupported MIME types
  - (Integration) Fetches https: URL with timeout
  - (Integration) Rejects private IP URLs (SSRF)

preprocess.test.ts
  - Resizes oversized JPEG to fit 5MB limit
  - Preserves PNG alpha channel
  - Converts HEIC to JPEG
  - Fixes EXIF rotation
  - Applies detail:low (512px max)
  - Grid search finds smallest acceptable quality
  - Passes through small-enough images without modification

format.test.ts
  - Formats for OpenAI (image_url with data URI)
  - Formats for Anthropic (image block with base64)
  - Formats for Google (inlineData)
  - Formats for Ollama (OpenAI-compatible)
```

### Manual curl Tests

```bash
# Image via base64 (JPEG)
curl http://localhost:51277/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this image?"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
      ]
    }],
    "max_tokens": 200
  }'

# Image via URL
curl http://localhost:51277/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this photo"},
        {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/320px-Camponotus_flavomarginatus_ant.jpg"}}
      ]
    }],
    "max_tokens": 200
  }'

# Vision fallback (image sent to text-only model)
curl http://localhost:51277/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3:30b",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What error is shown?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR..."}}
      ]
    }],
    "max_tokens": 200
  }'

# Multiple images in one message
curl http://localhost:51277/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Compare these two screenshots"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/first..."}},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/second..."}}
      ]
    }],
    "max_tokens": 300
  }'

# Text-only message (no images, should work as before)
curl http://localhost:51277/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```
