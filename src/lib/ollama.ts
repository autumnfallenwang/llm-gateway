import type { Model } from "@mariozechner/pi-ai";
import {
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_FETCH_TIMEOUT_MS,
  OLLAMA_SHOW_TIMEOUT_MS,
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

export interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

export interface OllamaModelCapabilities {
  supportsVision: boolean;
  supportsEmbedding: boolean;
  supportsCompletion: boolean;
  contextLength?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function extractContextLength(modelInfo: Record<string, unknown>): number | undefined {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
      return value;
    }
  }
  return undefined;
}

export async function fetchModelCapabilities(
  modelId: string,
  baseUrl?: string,
  timeoutMs?: number,
): Promise<OllamaModelCapabilities> {
  const base = baseUrl ?? OLLAMA_BASE_URL;
  const timeout = timeoutMs ?? OLLAMA_SHOW_TIMEOUT_MS;
  try {
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelId }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      return { supportsVision: false, supportsEmbedding: false, supportsCompletion: false };
    }
    const body = (await res.json()) as OllamaShowResponse;
    const caps = body.capabilities ?? [];
    const supportsVision = caps.includes("vision");
    const supportsEmbedding = caps.includes("embedding");
    const supportsCompletion = caps.includes("completion");
    const contextLength = body.model_info ? extractContextLength(body.model_info) : undefined;
    return { supportsVision, supportsEmbedding, supportsCompletion, contextLength };
  } catch {
    return { supportsVision: false, supportsEmbedding: false, supportsCompletion: false };
  }
}

export function buildOllamaModel(
  id: string,
  baseUrl?: string,
  capabilities?: OllamaModelCapabilities,
): Model<"openai-completions"> {
  const base = baseUrl ?? OLLAMA_BASE_URL;
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${base}/v1`,
    reasoning: false,
    input: capabilities?.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities?.contextLength ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface FetchedOllamaModel {
  model: Model<"openai-completions">;
  capabilities: OllamaModelCapabilities;
}

export async function fetchOllamaModels(baseUrl?: string): Promise<FetchedOllamaModel[]> {
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

    const capabilitiesResults = await Promise.all(
      body.data.map((entry) => fetchModelCapabilities(entry.id, base)),
    );

    const fetched: FetchedOllamaModel[] = body.data.map((entry, i) => ({
      model: buildOllamaModel(entry.id, base, capabilitiesResults[i]),
      capabilities: capabilitiesResults[i],
    }));

    const visionIds = fetched
      .filter(({ model }) => model.input.includes("image"))
      .map(({ model }) => model.id);
    if (visionIds.length > 0) {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.log(`[ollama] Vision-capable models: ${visionIds.join(", ")}`);
    }

    const embeddingIds = fetched
      .filter(
        ({ capabilities }) => capabilities.supportsEmbedding && !capabilities.supportsCompletion,
      )
      .map(({ model }) => model.id);
    if (embeddingIds.length > 0) {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.log(`[ollama] Embedding models: ${embeddingIds.join(", ")}`);
    }

    return fetched;
  } catch {
    // biome-ignore lint/suspicious/noConsole: intentional startup log
    console.warn("[ollama] Could not reach Ollama — local models unavailable");
    return [];
  }
}
