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
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 131072;
export const OLLAMA_DEFAULT_MAX_TOKENS = 4096;

// ── Auth ───────────────────────────────────────────────────────────────────

export const ANTHROPIC_CREDENTIALS_PATH =
  env.ANTHROPIC_CREDENTIALS_PATH ?? join(homedir(), ".claude", ".credentials.json");
export const CODEX_CREDENTIALS_PATH =
  env.CODEX_CREDENTIALS_PATH ?? join(homedir(), ".codex", "auth.json");

// ── Validation ─────────────────────────────────────────────────────────────

export const VALIDATION_FILE_PATH =
  env.VALIDATION_FILE_PATH ?? join(homedir(), ".llm-gateway", "models.json");
export const VALIDATION_CONCURRENCY = Number(env.VALIDATION_CONCURRENCY ?? 3);
export const VALIDATION_TIMEOUT_MS = Number(env.VALIDATION_TIMEOUT_MS ?? 60_000);
export const VALIDATION_MAX_TOKENS = 32;

// ── Image Loading ─────────────────────────────────────────────────────────
export const IMAGE_FETCH_TIMEOUT_MS = Number(env.IMAGE_FETCH_TIMEOUT_MS ?? 30_000);
export const IMAGE_FETCH_MAX_BYTES = Number(env.IMAGE_FETCH_MAX_BYTES ?? 20 * 1024 * 1024); // 20 MB

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
