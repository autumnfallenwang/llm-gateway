import { OLLAMA_BASE_URL } from "../config.js";
import { BackendError } from "../errors.js";
import type { EmbeddingsRequest, EmbeddingsResponse } from "../routes/embeddings.js";
import type { ResolvedModel } from "./registry.js";

const PROVIDER_LABELS: Record<string, string> = {
  ollama: "ollama",
  anthropic: "anthropic",
  codex: "openai-codex",
  gemini: "google-gemini-cli",
};

interface UpstreamError {
  error?: { message?: string };
}

export interface EmbeddingsOptions {
  signal?: AbortSignal;
}

export async function createEmbedding(
  resolved: ResolvedModel,
  body: EmbeddingsRequest,
  options?: EmbeddingsOptions,
): Promise<EmbeddingsResponse> {
  // Provider gate: only Ollama is wired up today. Anthropic has no embeddings API; Codex
  // and Gemini OAuth providers don't expose embedding models. See openai-embeddings-spec.md.
  if (resolved.provider !== "ollama") {
    const label = PROVIDER_LABELS[resolved.provider] ?? resolved.provider;
    throw new BackendError(
      `Provider '${label}' does not offer an embeddings API. Use an Ollama or OpenAI embedding model.`,
      501,
      "invalid_request_error",
      "provider_unsupported",
    );
  }

  // Capability gate: chat models would 5xx upstream; reject early with a clear message.
  if (resolved.capability !== "embedding") {
    throw new BackendError(
      `Model '${resolved.model.id}' is a chat model. Use POST /v1/chat/completions instead.`,
      400,
      "invalid_request_error",
      "wrong_capability",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown fetch error";
    // biome-ignore lint/nursery/useErrorCause: cause is passed as the 5th positional arg below; biome's heuristic only checks the 2nd arg
    throw new BackendError(
      `Ollama embeddings request failed: ${message}`,
      500,
      "server_error",
      "server_error",
      { cause: err },
    );
  }

  if (!res.ok) {
    let upstream: UpstreamError = {};
    try {
      upstream = (await res.json()) as UpstreamError;
    } catch {
      // upstream returned non-JSON; fall through with empty upstream
    }
    const message = upstream.error?.message ?? `Ollama returned HTTP ${res.status}`;

    // Ollama uses type:"not_found_error" + code:null on unknown model.
    // Rewrap to our standard envelope (invalid_request_error + model_not_found).
    if (res.status === 404) {
      throw new BackendError(message, 404, "invalid_request_error", "model_not_found");
    }
    if (res.status === 400) {
      throw new BackendError(message, 400, "invalid_request_error", "invalid_input");
    }
    if (res.status === 429) {
      throw new BackendError(message, 429, "rate_limit_exceeded", "rate_limit_exceeded");
    }
    throw new BackendError(message, 500, "server_error", "server_error");
  }

  return (await res.json()) as EmbeddingsResponse;
}
