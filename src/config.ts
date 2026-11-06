import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

// ── Server ─────────────────────────────────────────────────────────────────

export const LLM_GATEWAY_PORT = Number(env.LLM_GATEWAY_PORT ?? 51277);

/**
 * The host names this gateway answers to. Anything else gets a 403 (see lib/request-guard.ts). The chart lists what the
 * cluster uses; the default also covers `npm run dev` and the local test suites.
 */
export const LLMGW_ALLOWED_HOSTS = (
  env.LLMGW_ALLOWED_HOSTS ?? "llmgw.llmgw.svc.cluster.local,localhost,127.0.0.1,[::1]"
)
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

// ── Logging ────────────────────────────────────────────────────────────────

/** Minimum log level emitted to stdout. Set to "debug" for verbose troubleshooting. */
export const LOG_LEVEL = env.LOG_LEVEL ?? "info";

// ── App metadata ───────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

export const APP_NAME = "llm-gateway";
export const APP_VERSION: string = pkg.version;
/** The commit the image was built from (CI passes it as a build arg); null in dev. */
export const APP_COMMIT: string | null = env.LLMGW_COMMIT || null;
export const APP_DESCRIPTION = `Self-hosted OpenAI-compatible API gateway that routes requests to multiple LLM backends (Ollama, Anthropic, Codex) through a unified OpenAI-format API.

## Quick Start

Use any OpenAI-compatible SDK with \`baseURL\` pointed at this gateway. No API key is required — authentication to upstream providers is handled server-side. It answers only to the host names it's served under, and web pages can only call it from its own address.

The gateway runs on the home k3s cluster at \`http://llmgw.llmgw.svc.cluster.local\`, reachable from inside the cluster and from arch, whose \`/etc/hosts\` points that name at the Service. For local dev runs use \`http://localhost:${LLM_GATEWAY_PORT}\` instead.

### Chat completions

\`\`\`python
from openai import OpenAI
client = OpenAI(base_url="http://llmgw.llmgw.svc.cluster.local/v1", api_key="unused")
response = client.chat.completions.create(
    model="qwen3:30b",  # or claude-haiku-5-5, gpt-6-luna
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
- \`owned_by\`: backend (\`ollama\`, \`anthropic\`, \`openai-codex\`, \`deepseek\`)
- \`capability\`: \`"chat"\` (use \`/v1/chat/completions\`) or \`"embedding"\` (use \`/v1/embeddings\`)
- \`embedding_dimensions\`: vector length, populated for validated embedding models

## Usage limits

\`GET /v1/limits?model=<id>\` says how much of the model's allowance is left — subscriptions (Claude, GPT) as windows of percent used with reset times, DeepSeek as its prepaid balance, Ollama as unlimited — with one line to show in \`available\` and an overall \`status\` (\`ok\`, \`warning\`, \`exhausted\`, \`unknown\`). A model \`/v1/models\` lists with \`status: "error"\` (a GPT model the ChatGPT plan lacks, say) is \`unavailable\`, with the reason. Without \`model\` it lists every family. The numbers are the whole account's, including use outside the gateway.

## Model IDs

Request a model by the \`id\` \`/v1/models\` lists, or as \`owned_by/model\` to name the provider explicitly (\`anthropic/claude-haiku-5-5\`, \`deepseek/deepseek-flash\`, \`ollama/qwen3:30b\`). A bare ID works when one provider lists it; when several do, \`/v1/models\` lists each as \`owned_by/model\` and the bare ID returns 400 \`ambiguous_model\` naming the choices.

## Streaming

Set \`stream: true\` on chat completions to receive Server-Sent Events. Each event is \`data: {chunk_json}\\n\\n\` with object type \`chat.completion.chunk\`. The stream ends with \`data: [DONE]\\n\\n\`. With \`stream_options: {include_usage: true}\`, one last chunk before \`[DONE]\` has no choices and the whole request's \`usage\` (every other chunk carries \`usage: null\`), as OpenAI does. OpenAI SDKs handle this automatically. Embeddings do not stream.

## Vision

Send images via \`image_url\` content parts (HTTPS URLs or data URIs). Models whose \`/v1/models\` entry has \`input: ["text", "image"]\` read images themselves. For a text-only model, a vision model (of the same family where there is one) describes each image, and the description replaces the image where it was: \`[Image description: …]\`, or \`[Image 1 description: …]\`, \`[Image 2 description: …]\` for several. Descriptions are cached, so the images of earlier turns aren't described again.

## Reasoning and refusals

\`reasoning_effort\` (\`none\`, \`minimal\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`) sets how hard Claude, GPT and DeepSeek models think; each model moves it to the nearest level it has, so \`none\` on a model that always thinks is its lowest effort. Without it, each model keeps its default. When a Claude model's safety classifiers decline, the reply is a normal 200 with \`finish_reason: "content_filter"\` and the reason in \`message.refusal\` (\`delta.refusal\` when streaming).

## GPT models

GPT models (\`owned_by: "openai-codex"\`) run on a ChatGPT login, so which ones answer depends on its plan. \`/v1/models\` lists the others with \`status: "error"\` and the reason, and a request for one returns 404 \`model_not_found\`. They take no \`temperature\` (the gateway drops it) and no output limit (\`max_tokens\` is ignored).

## DeepSeek models

DeepSeek models (\`owned_by: "deepseek"\`: \`deepseek-flash\`, which also reads images, and \`deepseek-v4-pro\`) are metered, paid from a prepaid balance; an empty balance returns 429 \`insufficient_quota\`. They don't think unless the request sets \`reasoning_effort\`, and a forced \`tool_choice\` turns thinking off (DeepSeek can't force a tool while thinking). Images sent to \`deepseek-v4-pro\` are described by \`deepseek-flash\`.

## Embeddings

\`POST /v1/embeddings\` is OpenAI-compatible byte-for-byte. Currently routes to Ollama embedding models (\`bge-m3\`, \`qwen3-embedding\`, \`nomic-embed-text\`). Anthropic, Codex and DeepSeek don't offer embedding APIs and return \`501 provider_unsupported\`. Supported request fields: \`model\`, \`input\` (string or array of strings up to 2048 items), \`encoding_format\` (\`"float"\` default or \`"base64"\` for compact transport), \`dimensions\` (Matryoshka-style truncation), \`user\`. Token-array inputs are not supported.`;

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
 * Whether to load Codex credentials and register Codex models. Set `CODEX_ENABLED=false` on a
 * host with no ChatGPT login, so the Codex models don't surface as validation errors. The
 * login is any ChatGPT plan that includes Codex; Go gets gpt-6-luna, gpt-5.6-terra and
 * gpt-5.6-luna (2026-11-01).
 */
export const CODEX_ENABLED = (env.CODEX_ENABLED ?? "true").toLowerCase() !== "false";

/**
 * The DeepSeek API key: a static key in a plain-text file, the key's single source of truth
 * on the host (`~/.zshrc` reads it too). No file, no DeepSeek models. See
 * docs/deepseek-provider.md.
 */
export const DEEPSEEK_CREDENTIALS_PATH =
  env.DEEPSEEK_CREDENTIALS_PATH ?? join(homedir(), ".deepseek", "api_key");

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
/** At startup, validate the registered models that have no stored result yet (in the background). */
export const VALIDATE_NEW_MODELS_ON_BOOT = env.VALIDATE_NEW_MODELS_ON_BOOT !== "false";

// ── Image Loading ─────────────────────────────────────────────────────────
export const IMAGE_FETCH_TIMEOUT_MS = Number(env.IMAGE_FETCH_TIMEOUT_MS ?? 30_000);
export const IMAGE_FETCH_MAX_BYTES = Number(env.IMAGE_FETCH_MAX_BYTES ?? 20 * 1024 * 1024); // 20 MB

// ── Image Preprocessing ───────────────────────────────────────────────────
export const IMAGE_MAX_DIMENSION_PX = Number(env.IMAGE_MAX_DIMENSION_PX ?? 2048);
export const IMAGE_MAX_BYTES = Number(env.IMAGE_MAX_BYTES ?? 5 * 1024 * 1024); // 5 MB (Anthropic limit)
export const IMAGE_LOW_DETAIL_MAX_PX = 512;

// ── Usage limits (docs/usage-limits.md) ──────────────────────────────────

/** How long an account-usage endpoint result is reused before fetching again. */
export const LIMITS_CACHE_MS = Number(env.LIMITS_CACHE_MS ?? 60_000);
/** Limits older than this (the endpoint keeps failing) are reported as status "unknown". */
export const LIMITS_STALE_MS = Number(env.LIMITS_STALE_MS ?? 600_000);
/** A window at or above this percent used is a warning. */
export const LIMITS_WARN_PERCENT = Number(env.LIMITS_WARN_PERCENT ?? 80);
/** A prepaid balance below this (in its currency) is a warning. */
export const LIMITS_WARN_BALANCE = Number(env.LIMITS_WARN_BALANCE ?? 1);
/** Timeout for one account-usage endpoint request. */
export const LIMITS_FETCH_TIMEOUT_MS = Number(env.LIMITS_FETCH_TIMEOUT_MS ?? 10_000);

// ── Vision Fallback ──────────────────────────────────────────────────────

/**
 * Per-family preferred vision model (same-provider affinity). An empty value sends that
 * family to the general chain. DeepSeek's is `deepseek-flash`, which reads images itself:
 * `deepseek-v4-pro` (text only) then stays on the DeepSeek balance (well under a tenth of
 * a cent per image, once per image with the cache) instead of loading qwen3-vl on the GPU.
 */
export const VISION_FALLBACK_FAMILY: Record<string, string> = {
  ollama: env.VISION_FALLBACK_OLLAMA ?? "qwen3-vl:8b",
  anthropic: env.VISION_FALLBACK_ANTHROPIC ?? "claude-haiku-5-5",
  openai: env.VISION_FALLBACK_OPENAI ?? "gpt-6-luna",
  deepseek: env.VISION_FALLBACK_DEEPSEEK ?? "deepseek-flash",
};

/** General fallback chain if family model unavailable (comma-separated env override) */
export const VISION_FALLBACK_GENERAL: string[] = env.VISION_FALLBACK_GENERAL
  ? env.VISION_FALLBACK_GENERAL.split(",").map((s) => s.trim())
  : ["qwen3-vl:8b", "claude-haiku-5-5", "gpt-6-luna"];

export const VISION_FALLBACK_MAX_DESCRIPTION_CHARS = Number(
  env.VISION_FALLBACK_MAX_DESCRIPTION_CHARS ?? 1000,
);
export const VISION_FALLBACK_TIMEOUT_MS = Number(env.VISION_FALLBACK_TIMEOUT_MS ?? 30_000);
/** Days a vision-fallback description stays cached (SQLite); 0 turns the cache off. */
export const VISION_FALLBACK_CACHE_DAYS = Number(env.VISION_FALLBACK_CACHE_DAYS ?? 30);

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
