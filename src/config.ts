import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

// ── Server ─────────────────────────────────────────────────────────────────

export const LLM_GATEWAY_PORT = Number(env.LLM_GATEWAY_PORT ?? 51277);

// ── Logging ────────────────────────────────────────────────────────────────

/** Minimum log level emitted to stdout. Set to "debug" for verbose troubleshooting. */
export const LOG_LEVEL = env.LOG_LEVEL ?? "info";

// ── App metadata ───────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

export const APP_NAME = "llm-gateway";
export const APP_VERSION: string = pkg.version;
export const APP_DESCRIPTION = `Self-hosted OpenAI-compatible API gateway that routes requests to multiple LLM backends (Ollama, Anthropic, Codex) through a unified OpenAI-format API.

## Quick Start

Use any OpenAI-compatible SDK with \`baseURL\` pointed at this gateway. No API key is required — authentication to upstream providers is handled server-side.

The gateway is deployed at \`http://llmgw.arch.local\` (Traefik ingress on the home k3s cluster). For local dev runs use \`http://localhost:${LLM_GATEWAY_PORT}\` instead.

### Chat completions

\`\`\`python
from openai import OpenAI
client = OpenAI(base_url="http://llmgw.arch.local/v1", api_key="unused")
response = client.chat.completions.create(
    model="qwen3:30b",  # or claude-haiku-4-5, gpt-5.1
    messages=[{"role": "user", "content": "Hello!"}],
)
\`\`\`

### Embeddings

\`\`\`python
response = client.embeddings.create(
    model="bge-m3:latest",  # or qwen3-embedding:0.6b, nomic-embed-text:latest
    input="The quick brown fox",
)
print(len(response.data[0].embedding))  # 1024 for bge-m3
\`\`\`

## Available Models

Models are dynamic — they depend on which backends are configured. Call \`GET /v1/models\` to discover available models at runtime. Each model carries:
- \`owned_by\`: backend (\`ollama\`, \`anthropic\`, \`openai-codex\`)
- \`capability\`: \`"chat"\` (use \`/v1/chat/completions\`) or \`"embedding"\` (use \`/v1/embeddings\`)
- \`embedding_dimensions\`: vector length, populated for validated embedding models

## Streaming

Set \`stream: true\` on chat completions to receive Server-Sent Events. Each event is \`data: {chunk_json}\\n\\n\` with object type \`chat.completion.chunk\`. The stream ends with \`data: [DONE]\\n\\n\`. OpenAI SDKs handle this automatically. Embeddings do not stream.

## Vision

Send images via \`image_url\` content parts (HTTPS URLs or data URIs). Vision-capable models process images directly. Non-vision models automatically fall back to a vision model that describes the image as text.

## Embeddings

\`POST /v1/embeddings\` is OpenAI-compatible byte-for-byte. Currently routes to Ollama embedding models (\`bge-m3\`, \`qwen3-embedding\`, \`nomic-embed-text\`). Anthropic / Codex OAuth providers don't expose embedding APIs and return \`501 provider_unsupported\`. Supported request fields: \`model\`, \`input\` (string or array of strings up to 2048 items), \`encoding_format\` (\`"float"\` default or \`"base64"\` for compact transport), \`dimensions\` (Matryoshka-style truncation), \`user\`. Token-array inputs are not supported.`;

// ── Ollama ─────────────────────────────────────────────────────────────────

export const OLLAMA_BASE_URL = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
export const OLLAMA_FETCH_TIMEOUT_MS = Number(env.OLLAMA_FETCH_TIMEOUT_MS ?? 2000);
export const OLLAMA_SHOW_TIMEOUT_MS = Number(env.OLLAMA_SHOW_TIMEOUT_MS ?? 2000);
export const OLLAMA_NUM_CTX = Number(env.OLLAMA_NUM_CTX ?? 32768);
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 131072;
export const OLLAMA_DEFAULT_MAX_TOKENS = 4096;

// ── Auth ───────────────────────────────────────────────────────────────────

/**
 * Anthropic seed: the host's read-only `~/.claude/.credentials.json`. The container reads it
 * once on first boot to bootstrap, then maintains its own independent OAuth chain in
 * `ANTHROPIC_CACHE_PATH`. Never written to.
 */
export const ANTHROPIC_SEED_PATH =
  env.ANTHROPIC_SEED_PATH ?? join(homedir(), ".claude", ".credentials.json");

export const CODEX_CREDENTIALS_PATH =
  env.CODEX_CREDENTIALS_PATH ?? join(homedir(), ".codex", "auth.json");

/**
 * Whether to load Codex credentials and register Codex models. Defaults to enabled to preserve
 * local/dev behavior; the cluster sets `CODEX_ENABLED=false` (no active subscription) so the
 * Codex models don't surface as validation errors. Flip the env var to re-enable — no code change.
 */
export const CODEX_ENABLED = (env.CODEX_ENABLED ?? "true").toLowerCase() !== "false";

/**
 * Skew applied when checking Anthropic token expiry. Refresh fires whenever
 * `now > expires - ANTHROPIC_REFRESH_SKEW_MS` so we never serve a request with a
 * token that's about to expire mid-flight.
 */
export const ANTHROPIC_REFRESH_SKEW_MS = Number(env.ANTHROPIC_REFRESH_SKEW_MS ?? 60_000);

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * SQLite database path. Backs the credential chain + model validation report.
 * In the k3s deploy this is on the writable 1Gi `local-path` PVC.
 */
export const LLMGW_DB_PATH = env.LLMGW_DB_PATH ?? join(homedir(), ".llm-gateway", "state.db");

// ── Validation ─────────────────────────────────────────────────────────────

export const VALIDATION_CONCURRENCY = Number(env.VALIDATION_CONCURRENCY ?? 3);
export const VALIDATION_TIMEOUT_MS = Number(env.VALIDATION_TIMEOUT_MS ?? 60_000);
export const VALIDATION_MAX_TOKENS = 32;

// ── Image Loading ─────────────────────────────────────────────────────────
export const IMAGE_FETCH_TIMEOUT_MS = Number(env.IMAGE_FETCH_TIMEOUT_MS ?? 30_000);
export const IMAGE_FETCH_MAX_BYTES = Number(env.IMAGE_FETCH_MAX_BYTES ?? 20 * 1024 * 1024); // 20 MB

// ── Image Preprocessing ───────────────────────────────────────────────────
export const IMAGE_MAX_DIMENSION_PX = Number(env.IMAGE_MAX_DIMENSION_PX ?? 2048);
export const IMAGE_MAX_BYTES = Number(env.IMAGE_MAX_BYTES ?? 5 * 1024 * 1024); // 5 MB (Anthropic limit)
export const IMAGE_LOW_DETAIL_MAX_PX = 512;

// ── Vision Fallback ──────────────────────────────────────────────────────

/** Per-family preferred vision model (same-provider affinity) */
export const VISION_FALLBACK_FAMILY: Record<string, string> = {
  ollama: env.VISION_FALLBACK_OLLAMA ?? "qwen3-vl:8b",
  anthropic: env.VISION_FALLBACK_ANTHROPIC ?? "claude-haiku-4-5",
  openai: env.VISION_FALLBACK_OPENAI ?? "gpt-4o-mini",
};

/** General fallback chain if family model unavailable (comma-separated env override) */
export const VISION_FALLBACK_GENERAL: string[] = env.VISION_FALLBACK_GENERAL
  ? env.VISION_FALLBACK_GENERAL.split(",").map((s) => s.trim())
  : ["qwen3-vl:8b", "claude-haiku-4-5", "gpt-4o-mini"];

export const VISION_FALLBACK_MAX_DESCRIPTION_CHARS = Number(
  env.VISION_FALLBACK_MAX_DESCRIPTION_CHARS ?? 1000,
);
export const VISION_FALLBACK_TIMEOUT_MS = Number(env.VISION_FALLBACK_TIMEOUT_MS ?? 30_000);

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
