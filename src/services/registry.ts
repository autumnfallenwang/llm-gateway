import { log } from "../lib/logger.js";
import { fetchOllamaModels, type OllamaModelCapabilities } from "../lib/ollama.js";
import { getModels, type Model } from "../lib/pi.js";
import { getAnthropicKey, getCodexKey, getDeepseekKey } from "./auth.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type Capability = "chat" | "embedding";

type Provider = "ollama" | "anthropic" | "codex" | "deepseek";

export interface ResolvedModel {
  /** The ID /v1/models lists it under: bare when unique, `owned_by/model` when not. */
  id: string;
  model: Model<string>;
  provider: Provider;
  capability: Capability;
  apiKey?: string;
}

export interface RegistryConfig {
  ollamaBaseUrl?: string;
}

/** What a model ID names: one model, several (a bare ID two providers share), or none. */
export type ModelLookup =
  | { kind: "found"; resolved: ResolvedModel }
  | { kind: "ambiguous"; choices: string[] }
  | { kind: "missing" };

interface RegistryEntry {
  /** The listed ID (see ResolvedModel.id). */
  id: string;
  model: Model<string>;
  provider: Provider;
  capability: Capability;
}

// ── Module state ────────────────────────────────────────────────────────────

/** Every registered model, in listing order (Ollama, Anthropic, Codex, DeepSeek). */
let entries: RegistryEntry[] = [];
/** Bare model ID → its entries; more than one means the bare ID is ambiguous. */
let byBareId = new Map<string, RegistryEntry[]>();

// ── Helpers ─────────────────────────────────────────────────────────────────

function inferOllamaCapability(caps: OllamaModelCapabilities): Capability {
  if (caps.supportsEmbedding && !caps.supportsCompletion) return "embedding";
  return "chat";
}

/** `owned_by/model` — the prefix is the model's public provider name (`owned_by`). */
function qualifiedId(model: Model<string>): string {
  return `${model.provider}/${model.id}`;
}

function apiKeyFor(provider: Provider): string | undefined {
  if (provider === "anthropic") return getAnthropicKey();
  if (provider === "codex") return getCodexKey();
  if (provider === "deepseek") return getDeepseekKey();
  return undefined;
}

function toResolved(entry: RegistryEntry): ResolvedModel {
  const { id, model, provider, capability } = entry;
  const apiKey = apiKeyFor(provider);
  return { id, model, provider, capability, ...(apiKey !== undefined && { apiKey }) };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadRegistry(config?: RegistryConfig): Promise<void> {
  const ollamaFetched = await fetchOllamaModels(config?.ollamaBaseUrl);
  const chat = (provider: Provider) => (model: Model<string>) => ({
    model,
    provider,
    capability: "chat" as const,
  });
  const loaded: Omit<RegistryEntry, "id">[] = [
    ...ollamaFetched.map(({ model, capabilities }) => ({
      model,
      provider: "ollama" as const,
      capability: inferOllamaCapability(capabilities),
    })),
    ...(getAnthropicKey() ? getModels("anthropic").map(chat("anthropic")) : []),
    ...(getCodexKey() ? getModels("openai-codex").map(chat("codex")) : []),
    ...(getDeepseekKey() ? getModels("deepseek").map(chat("deepseek")) : []),
  ];

  const counts = new Map<string, number>();
  for (const e of loaded) counts.set(e.model.id, (counts.get(e.model.id) ?? 0) + 1);
  entries = loaded.map((e) => ({
    ...e,
    id: (counts.get(e.model.id) ?? 0) > 1 ? qualifiedId(e.model) : e.model.id,
  }));
  byBareId = new Map();
  for (const e of entries) byBareId.set(e.model.id, [...(byBareId.get(e.model.id) ?? []), e]);

  const ambiguous = [...byBareId].filter(([, list]) => list.length > 1);
  if (ambiguous.length > 0) {
    log.warn(
      {
        event: "registry.ambiguous_models",
        models: ambiguous.map(([id, list]) => ({ id, as: list.map((e) => e.id) })),
      },
      "Several providers list the same model ID — use provider/model to pick one",
    );
  }

  const count = (provider: Provider) => entries.filter((e) => e.provider === provider).length;
  log.info(
    {
      event: "registry.loaded",
      ollama: count("ollama"),
      anthropic: count("anthropic"),
      codex: count("codex"),
      deepseek: count("deepseek"),
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
  input: ("text" | "image")[];
  context_window?: number;
  max_tokens?: number;
}[] {
  return entries.map(({ id, model, capability }) => ({
    id,
    object: "model" as const,
    created: 0,
    owned_by: model.provider,
    capability,
    input: [...model.input],
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
  }));
}

/**
 * What a model ID names. `owned_by/model` (e.g. `deepseek/deepseek-flash`) always names one
 * model; a bare ID names its model when only one provider has it, and is ambiguous when
 * several do. A slash counts as a provider prefix only when the prefix is one of ours and
 * the rest is that provider's model — Ollama community names (`user/model:tag`,
 * `hf.co/…`) stay whole model IDs. See docs/model-ids.md.
 */
export function lookupModel(modelId: string): ModelLookup {
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const prefix = modelId.slice(0, slash);
    const rest = modelId.slice(slash + 1);
    const qualified = entries.find((e) => e.model.provider === prefix && e.model.id === rest);
    if (qualified) return { kind: "found", resolved: toResolved(qualified) };
  }
  const bare = byBareId.get(modelId) ?? [];
  if (bare.length === 1 && bare[0]) return { kind: "found", resolved: toResolved(bare[0]) };
  if (bare.length > 1) return { kind: "ambiguous", choices: bare.map((e) => e.id) };
  return { kind: "missing" };
}

/** The model an ID names, or undefined when it names none or is ambiguous. */
export function resolveModel(modelId: string): ResolvedModel | undefined {
  const found = lookupModel(modelId);
  return found.kind === "found" ? found.resolved : undefined;
}
