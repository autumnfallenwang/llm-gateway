import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

// ── Server ─────────────────────────────────────────────────────────────────

export const LLM_GATEWAY_PORT = Number(env.LLM_GATEWAY_PORT ?? 51277);

// ── App metadata ───────────────────────────────────────────────────────────

export const APP_NAME = "llm-gateway";
export const APP_VERSION = "0.1.0";
export const APP_DESCRIPTION =
  "Self-hosted OpenAI-compatible API gateway for multiple LLM backends";

// ── Ollama ─────────────────────────────────────────────────────────────────

export const OLLAMA_BASE_URL = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
export const OLLAMA_FETCH_TIMEOUT_MS = Number(env.OLLAMA_FETCH_TIMEOUT_MS ?? 2000);
export const OLLAMA_SHOW_TIMEOUT_MS = Number(env.OLLAMA_SHOW_TIMEOUT_MS ?? 2000);
export const OLLAMA_NUM_CTX = Number(env.OLLAMA_NUM_CTX ?? 32768);
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 131072;
export const OLLAMA_DEFAULT_MAX_TOKENS = 4096;

// ── Auth ───────────────────────────────────────────────────────────────────

export const GEMINI_PROJECT_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

export const ANTHROPIC_CREDENTIALS_PATH =
  env.ANTHROPIC_CREDENTIALS_PATH ?? join(homedir(), ".claude", ".credentials.json");
export const CODEX_CREDENTIALS_PATH =
  env.CODEX_CREDENTIALS_PATH ?? join(homedir(), ".codex", "auth.json");
export const GEMINI_CREDENTIALS_PATH =
  env.GEMINI_CREDENTIALS_PATH ?? join(homedir(), ".gemini", "oauth_creds.json");

// ── Validation ─────────────────────────────────────────────────────────────

export const VALIDATION_FILE_PATH =
  env.VALIDATION_FILE_PATH ?? join(homedir(), ".llm-gateway", "models.json");
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
  "google-gemini-cli": env.VISION_FALLBACK_GEMINI ?? "gemini-2.0-flash",
};

/** General fallback chain if family model unavailable (comma-separated env override) */
export const VISION_FALLBACK_GENERAL: string[] = env.VISION_FALLBACK_GENERAL
  ? env.VISION_FALLBACK_GENERAL.split(",").map((s) => s.trim())
  : ["qwen3-vl:8b", "claude-haiku-4-5", "gpt-4o-mini", "gemini-2.0-flash"];

export const VISION_FALLBACK_MAX_DESCRIPTION_CHARS = Number(
  env.VISION_FALLBACK_MAX_DESCRIPTION_CHARS ?? 1000,
);
export const VISION_FALLBACK_TIMEOUT_MS = Number(env.VISION_FALLBACK_TIMEOUT_MS ?? 30_000);

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
