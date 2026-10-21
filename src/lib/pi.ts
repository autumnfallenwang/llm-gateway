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
  type Model,
  normalizeContext,
  type ProviderStreamOptions,
  isContextOverflow as piIsContextOverflow,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { stream as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as openaiCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
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
  // pi-ai 0.73 defaulted Anthropic max_tokens to a third of the model's maximum; 1.x
  // sends the whole maximum. Keep the old default for callers that don't set one.
  const opts =
    model.api === "anthropic-messages" && options?.maxTokens === undefined
      ? { ...options, maxTokens: Math.floor(model.maxTokens / 3) }
      : options;
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
// this model", checked live 2026-10-21), but pi-ai 1.3's catalog doesn't flag them.
const NO_TEMPERATURE = new Set(["claude-sonnet-5", "claude-fable-5"]);

/** pi-ai's static model catalog for a provider, with known catalog gaps corrected. */
export function getModels(provider: "anthropic" | "openai-codex"): Model<Api>[] {
  return (getBuiltinModels(provider) as Model<Api>[]).map((m) =>
    NO_TEMPERATURE.has(m.id)
      ? ({ ...m, compat: { ...m.compat, supportsTemperature: false } } as Model<Api>)
      : m,
  );
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
