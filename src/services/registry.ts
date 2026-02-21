import { getModels, type Model } from "@mariozechner/pi-ai";
import { fetchOllamaModels } from "../lib/ollama.js";
import { getAnthropicKey, getCodexKey, getGeminiKey } from "./auth.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedModel {
  model: Model<string>;
  provider: "ollama" | "anthropic" | "codex" | "gemini";
  apiKey?: string;
}

export interface RegistryConfig {
  ollamaBaseUrl?: string;
}

// ── Module state ────────────────────────────────────────────────────────────

let ollamaModels: Model<string>[] = [];
let anthropicModels: Model<string>[] = [];
let codexModels: Model<string>[] = [];
let geminiModels: Model<string>[] = [];

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadRegistry(config?: RegistryConfig): Promise<void> {
  ollamaModels = await fetchOllamaModels(config?.ollamaBaseUrl);

  anthropicModels = getAnthropicKey() ? getModels("anthropic") : [];
  codexModels = getCodexKey() ? getModels("openai-codex") : [];
  geminiModels = getGeminiKey() ? getModels("google-gemini-cli") : [];

  // biome-ignore lint/suspicious/noConsole: intentional startup log
  console.log(
    `[registry] Loaded ${ollamaModels.length} Ollama, ${anthropicModels.length} Anthropic, ${codexModels.length} Codex, ${geminiModels.length} Gemini models`,
  );
}

export function listModels(): {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window?: number;
  max_tokens?: number;
}[] {
  const all = [
    ...ollamaModels.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: m.provider,
      context_window: m.contextWindow,
      max_tokens: m.maxTokens,
    })),
    ...anthropicModels.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: m.provider,
      context_window: m.contextWindow,
      max_tokens: m.maxTokens,
    })),
    ...codexModels.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: m.provider,
      context_window: m.contextWindow,
      max_tokens: m.maxTokens,
    })),
    ...geminiModels.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: m.provider,
      context_window: m.contextWindow,
      max_tokens: m.maxTokens,
    })),
  ];
  return all;
}

export function resolveModel(modelId: string): ResolvedModel | undefined {
  const ollama = ollamaModels.find((m) => m.id === modelId);
  if (ollama) return { model: ollama, provider: "ollama" };

  const anthropic = anthropicModels.find((m) => m.id === modelId);
  if (anthropic) return { model: anthropic, provider: "anthropic", apiKey: getAnthropicKey() };

  const codex = codexModels.find((m) => m.id === modelId);
  if (codex) return { model: codex, provider: "codex", apiKey: getCodexKey() };

  const gemini = geminiModels.find((m) => m.id === modelId);
  if (gemini) return { model: gemini, provider: "gemini", apiKey: getGeminiKey() };

  return undefined;
}
