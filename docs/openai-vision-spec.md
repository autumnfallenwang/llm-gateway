# OpenAI Vision API — Quick Reference

Source: https://developers.openai.com/api/docs/guides/images-vision/

## Key Fact

The **only** difference from text-only requests is `messages[].content` becomes `string | ContentPart[]`. Request params and response format are identical.

## Content Part Types

```jsonc
// text part
{ "type": "text", "text": "What's in this image?" }

// image part
{ "type": "image_url", "image_url": { "url": "...", "detail": "high" } }
```

`url` accepts: HTTPS URL or `data:image/{format};base64,...` data URI.

## `detail` Parameter

| Value | Behavior | Token Cost |
|-------|----------|------------|
| `low` | 512x512 | Fixed 85 tokens |
| `high` | Up to 2048px, tiled at 512px | 170 tokens/tile + 85 base |
| `auto` | Model decides | Varies |

## Supported Formats

JPEG, PNG, WebP, non-animated GIF

## Limits

- Max 500 images per request
- Each image counted as prompt tokens
- 50MB total payload

## Response

Identical to text completions — `choices[0].message.content` is plain text. Image tokens appear in `usage.prompt_tokens`. No special fields.

---

## pi-ai Library Behavior

pi-ai already supports image input natively. No format conversion needed on our side.

### UserMessage content type

```typescript
content: string | (TextContent | ImageContent)[]
```

### ImageContent format

```typescript
{ type: "image", data: string, mimeType: string }  // data = base64
```

### Model vision capability

Each model declares `input: ("text" | "image")[]`. Vision models have `["text", "image"]`.

### Non-vision model handling

pi-ai **silently strips image parts** when `!model.input.includes("image")`. Every provider filters before sending:

- OpenAI: `content.filter(c => c.type !== "image_url")`
- Anthropic: `blocks.filter(b => b.type !== "image")`
- Google: `parts.filter(p => p.text !== undefined)`

No error, no warning — images vanish, model sees text only. This is why our vision fallback (Stage 5B) matters: without it, users get confusing text-only responses with no indication their images were ignored.

### pi-ai static model registry

Vision support is **hardcoded** in `models.generated.js` (auto-generated at build time). No runtime detection.

| Provider | Image support | Text-only |
|----------|--------------|-----------|
| Anthropic | All models (claude-3+, claude-4+) | None |
| OpenAI | Nearly all (gpt-4o, gpt-4.1, gpt-5, o1, o3, etc.) | Only `gpt-4` (original), `o3-mini`, `codex-mini-latest` |
| Ollama | **Not in registry at all** | — |

Check at request time: `resolved.model.input.includes("image")`.

### Ollama gap

Our `buildOllamaModel()` hardcodes `input: ["text"]` for all Ollama models. Vision models like `llava`, `llama3.2-vision` are incorrectly marked text-only. pi-ai will silently strip their images.

Ollama itself returns a **500 error** if images reach a non-vision model: `"this model is missing data required for image input"`. But pi-ai strips images before they reach Ollama, so this error never fires — images just vanish silently.

Needs fixing: detect Ollama vision models (name heuristic or `/api/show` endpoint).

---

## OpenClaw Vision Fallback Policy

### Flow

1. User sends image + text → target model
2. Check `model.input.includes("image")`
3. **If yes** — pass image directly, no conversion
4. **If no** — pick a fallback vision model, describe image as text, send text to target model

### Fallback model selection (priority order)

1. **User config** — `agents.defaults.imageModel.primary` (explicit override)
2. **Config fallback chain** — `agents.defaults.imageModel.fallbacks` (tried in order)
3. **Auto-detect** — checks which providers have valid API keys, uses hardcoded defaults:

```
openai    → gpt-5-mini
anthropic → claude-opus-4-6
google    → gemini-3-flash-preview
```

Cross-family is fine — a text-only OpenAI model can use Anthropic for image description. First available model with a valid API key wins.

### Vision detection source

Same pi-ai model catalog we use. `modelSupportsVision(entry)` checks `entry.input.includes("image")`. No external API calls for capability detection.
