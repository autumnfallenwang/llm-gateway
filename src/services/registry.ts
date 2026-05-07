import { getModels, type Model } from "@mariozechner/pi-ai";
import { log } from "../lib/logger.js";
import { fetchOllamaModels, type OllamaModelCapabilities } from "../lib/ollama.js";
import { getAnthropicKey, getCodexKey, getGeminiKey } from "./auth.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type Capability = "chat" | "embedding";

export interface ResolvedModel {
  model: Model<string>;
  provider: "ollama" | "anthropic" | "codex" | "gemini";
  capability: Capability;
  apiKey?: string;
}

export interface RegistryConfig {
  ollamaBaseUrl?: string;
}

interface RegistryEntry {
  model: Model<string>;
  capability: Capability;
}

// ── Module state ────────────────────────────────────────────────────────────

let ollamaEntries: RegistryEntry[] = [];
let anthropicEntries: RegistryEntry[] = [];
let codexEntries: RegistryEntry[] = [];
let geminiEntries: RegistryEntry[] = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

function inferOllamaCapability(caps: OllamaModelCapabilities): Capability {
  if (caps.supportsEmbedding && !caps.supportsCompletion) return "embedding";
  return "chat";
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadRegistry(config?: RegistryConfig): Promise<void> {
  const ollamaFetched = await fetchOllamaModels(config?.ollamaBaseUrl);
  ollamaEntries = ollamaFetched.map(({ model, capabilities }) => ({
    model,
    capability: inferOllamaCapability(capabilities),
  }));

  anthropicEntries = getAnthropicKey()
    ? getModels("anthropic").map((m) => ({ model: m, capability: "chat" as const }))
    : [];
  codexEntries = getCodexKey()
    ? getModels("openai-codex").map((m) => ({ model: m, capability: "chat" as const }))
    : [];
  geminiEntries = getGeminiKey()
    ? getModels("google-gemini-cli").map((m) => ({ model: m, capability: "chat" as const }))
    : [];

  log.info(
    {
      event: "registry.loaded",
      ollama: ollamaEntries.length,
      anthropic: anthropicEntries.length,
      codex: codexEntries.length,
      gemini: geminiEntries.length,
    },
    "Model registry loaded",
  );
}

export function listModels(): {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  capability: Capability;
  context_window?: number;
  max_tokens?: number;
}[] {
  const toRow = ({ model, capability }: RegistryEntry) => ({
    id: model.id,
    object: "model" as const,
    created: 0,
    owned_by: model.provider,
    capability,
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
  });
  return [
    ...ollamaEntries.map(toRow),
    ...anthropicEntries.map(toRow),
    ...codexEntries.map(toRow),
    ...geminiEntries.map(toRow),
  ];
}

export function resolveModel(modelId: string): ResolvedModel | undefined {
  const ollama = ollamaEntries.find((e) => e.model.id === modelId);
  if (ollama) return { model: ollama.model, provider: "ollama", capability: ollama.capability };

  const anthropic = anthropicEntries.find((e) => e.model.id === modelId);
  if (anthropic)
    return {
      model: anthropic.model,
      provider: "anthropic",
      capability: anthropic.capability,
      apiKey: getAnthropicKey(),
    };

  const codex = codexEntries.find((e) => e.model.id === modelId);
  if (codex)
    return {
      model: codex.model,
      provider: "codex",
      capability: codex.capability,
      apiKey: getCodexKey(),
    };

  const gemini = geminiEntries.find((e) => e.model.id === modelId);
  if (gemini)
    return {
      model: gemini.model,
      provider: "gemini",
      capability: gemini.capability,
      apiKey: getGeminiKey(),
    };

  return undefined;
}
