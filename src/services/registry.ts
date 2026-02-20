import { getModels, type Model } from "@mariozechner/pi-ai";
import { fetchOllamaModels } from "../lib/ollama.js";
import { getAnthropicKey, getCodexKey } from "./auth.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedModel {
  model: Model<string>;
  provider: "ollama" | "anthropic" | "codex";
  apiKey?: string;
}

export interface RegistryConfig {
  ollamaBaseUrl?: string;
}

// ── Module state ────────────────────────────────────────────────────────────

let ollamaModels: Model<string>[] = [];
let anthropicModels: Model<string>[] = [];
let codexModels: Model<string>[] = [];

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadRegistry(config?: RegistryConfig): Promise<void> {
  ollamaModels = await fetchOllamaModels(config?.ollamaBaseUrl);

  anthropicModels = getAnthropicKey() ? getModels("anthropic") : [];
  codexModels = getCodexKey() ? getModels("openai-codex") : [];

  // biome-ignore lint/suspicious/noConsole: intentional startup log
  console.log(
    `[registry] Loaded ${ollamaModels.length} Ollama, ${anthropicModels.length} Anthropic, ${codexModels.length} Codex models`,
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

  return undefined;
}
