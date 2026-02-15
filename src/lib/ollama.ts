import type { Model } from "@mariozechner/pi-ai";
import {
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_FETCH_TIMEOUT_MS,
} from "../config.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface OllamaModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface OllamaModelsResponse {
  object: "list";
  data: OllamaModelEntry[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function buildOllamaModel(id: string, baseUrl?: string): Model<"openai-completions"> {
  const base = baseUrl ?? OLLAMA_BASE_URL;
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${base}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function fetchOllamaModels(baseUrl?: string): Promise<Model<"openai-completions">[]> {
  const base = baseUrl ?? OLLAMA_BASE_URL;
  try {
    const res = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(OLLAMA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn(`[ollama] Unexpected status ${res.status} from ${base}/v1/models`);
      return [];
    }
    const body = (await res.json()) as OllamaModelsResponse;
    return body.data.map((entry) => buildOllamaModel(entry.id, base));
  } catch {
    // biome-ignore lint/suspicious/noConsole: intentional startup log
    console.warn("[ollama] Could not reach Ollama — local models unavailable");
    return [];
  }
}
