/**
 * The one place that knows pi-ai's API. pi-ai reshuffles its entry points between
 * releases (0.73 moved OAuth to a subpath; 1.x renamed the package to
 * `@earendil-works/pi-ai` and replaced the global registry with provider
 * collections), so the rest of the gateway imports from here and a future bump
 * touches this file only.
 *
 * We call the per-API stream functions directly with an explicit `apiKey`: the
 * gateway owns its credentials (see services/auth.ts), so pi-ai's own credential
 * store and env-var auth resolution are not used.
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  clampThinkingLevel,
  type Model,
  type ModelThinkingLevel,
  normalizeContext,
  type ProviderStreamOptions,
  isContextOverflow as piIsContextOverflow,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { stream as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as openaiCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { adjustMaxTokensForThinking } from "@earendil-works/pi-ai/api/simple-options";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

export type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

/** True when a failed reply was the backend refusing an over-long context. */
export const isContextOverflow = piIsContextOverflow;

// Ollama speaks OpenAI chat completions; Anthropic and Codex use their own APIs.
const STREAMS: Partial<Record<Api, StreamFunction<never, never>>> = {
  "anthropic-messages": anthropicMessages as StreamFunction<never, never>,
  "openai-completions": openaiCompletions as StreamFunction<never, never>,
  "openai-codex-responses": openaiCodexResponses as StreamFunction<never, never>,
};

export function stream(
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  const fn = STREAMS[model.api];
  if (!fn) throw new Error(`no backend for API '${model.api}' (model ${model.id})`);
  const opts = { ...options };
  // pi-ai 0.73 defaulted Anthropic max_tokens to a third of the model's maximum; 1.x
  // sends the whole maximum. Keep the old default for callers that don't set one.
  if (model.api === "anthropic-messages" && opts.maxTokens === undefined) {
    opts.maxTokens = Math.floor(model.maxTokens / 3);
  }
  // pi-ai's Anthropic backend drops temperature where the model refuses it; its Codex
  // backend sends it regardless, so drop it here for every model flagged as refusing it.
  if (
    (model.compat as { supportsTemperature?: boolean } | undefined)?.supportsTemperature === false
  ) {
    opts.temperature = undefined;
  }
  return fn(model as never, normalizeContext(context), opts as never);
}

/** Non-streaming call. Backend failures come back as `stopReason: "error"`, not a throw. */
export function complete(
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  return stream(model, context, options).result();
}

// Anthropic rejects a non-default temperature on these ("`temperature` is deprecated for
// this model", checked live 2026-10-21), but pi-ai's catalog (1.3, still 1.4) doesn't flag
// them. The Codex backend rejects it on every model ("Unsupported parameter: temperature",
// checked live 2026-11-01).
const NO_TEMPERATURE = new Set(["claude-sonnet-5", "claude-fable-5"]);

// Anthropic's retirement dates (requests fail from that day on) for models pi-ai still lists.
const RETIRES: Record<string, string> = {
  "claude-sonnet-4-5": "2026-11-30",
  "claude-sonnet-4-5-20250929": "2026-11-30",
};

function retired(id: string): boolean {
  const date = RETIRES[id];
  return date !== undefined && Date.now() >= Date.parse(`${date}T00:00:00Z`);
}

/** pi-ai's static model catalog for a provider, with known catalog gaps corrected. */
export function getModels(provider: "anthropic" | "openai-codex" | "deepseek"): Model<Api>[] {
  return (getBuiltinModels(provider) as Model<Api>[])
    .filter((m) => !retired(m.id))
    .map((m) =>
      provider === "openai-codex" || NO_TEMPERATURE.has(m.id)
        ? ({ ...m, compat: { ...m.compat, supportsTemperature: false } } as Model<Api>)
        : m,
    );
}

/** OpenAI's `reasoning_effort` levels, plus the `max` that Claude and Codex models have. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * pi-ai stream options that apply an OpenAI-style `reasoning_effort` to a model, mapped the
 * way pi-ai's own `streamSimple` maps a thinking level for each API. The level is first
 * moved to the nearest one the model has, so "none" on a model that always thinks becomes
 * its lowest effort. Models that don't reason (all of Ollama's, here) get nothing.
 *
 * `maxTokens` is the caller's max_tokens: Claude 4.5 and older think within a token budget
 * that has to fit inside it, so those get a raised max_tokens back.
 */
export function reasoningOptions(
  model: Model<Api>,
  effort: ReasoningEffort,
  maxTokens?: number,
): Record<string, unknown> {
  if (!model.reasoning) return {};
  const level = clampThinkingLevel(model, effort === "none" ? "off" : effort);
  if (model.api === "openai-codex-responses") {
    return { reasoningEffort: level === "off" ? "none" : level };
  }
  if (model.api === "openai-completions") {
    // DeepSeek: pi-ai turns thinking on for any level and sends `thinking: disabled` without.
    return level === "off" ? {} : { reasoningEffort: level };
  }
  if (model.api !== "anthropic-messages") return {};
  if (level === "off") return { thinkingEnabled: false };
  if ((model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking) {
    return { thinkingEnabled: true, effort: anthropicEffort(model, level) };
  }
  const adjusted = adjustMaxTokensForThinking(maxTokens, model.maxTokens, level);
  return {
    thinkingEnabled: true,
    maxTokens: adjusted.maxTokens,
    thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, adjusted.maxTokens - 1024)),
  };
}

/** Anthropic's effort for a level the model has (pi-ai's mapThinkingLevelToEffort). */
function anthropicEffort(model: Model<Api>, level: Exclude<ModelThinkingLevel, "off">): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  return level === "minimal" ? "low" : level;
}

const anthropicOAuth = anthropicProvider().auth.oauth;

/**
 * Exchange an Anthropic (Claude Pro/Max) refresh token. Refresh tokens are single-use:
 * the returned `refresh` replaces the one passed in. Throws on failure; an
 * `invalid_grant` message means the token was already used or revoked.
 */
export async function refreshAnthropicToken(
  refresh: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  if (!anthropicOAuth) throw new Error("pi-ai's Anthropic provider has no OAuth support");
  const next = await anthropicOAuth.refresh(
    { type: "oauth", refresh, access: "", expires: 0 },
    AbortSignal.timeout(30_000),
  );
  return { access: next.access, refresh: next.refresh, expires: next.expires };
}
