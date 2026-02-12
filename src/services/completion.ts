import {
  type AssistantMessage,
  type Context,
  complete,
  type Message,
  stream,
  type Usage,
} from "@mariozechner/pi-ai";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../routes/chat.js";
import type { ResolvedModel } from "./registry.js";

const STOP_REASON_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  toolUse: "tool_calls",
};

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildContext(body: ChatCompletionRequest, resolved: ResolvedModel): Context {
  let systemPrompt: string | undefined;
  const messages: Message[] = [];

  for (const msg of body.messages) {
    if (msg.role === "system") {
      systemPrompt ??= msg.content;
      continue;
    }

    if (msg.role === "user") {
      messages.push({
        role: "user",
        content: msg.content,
        timestamp: Date.now(),
      });
    } else if (msg.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: msg.content }],
        api: resolved.model.api,
        provider: resolved.model.provider,
        model: resolved.model.id,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
  }

  // Codex API requires instructions (system prompt) to be present
  if (!systemPrompt && resolved.provider === "codex") {
    systemPrompt = "You are a helpful assistant.";
  }

  return { systemPrompt, messages };
}

function buildOptions(
  body: ChatCompletionRequest,
  resolved: ResolvedModel,
): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (body.temperature !== undefined) opts.temperature = body.temperature;
  if (body.max_tokens !== undefined) opts.maxTokens = body.max_tokens;
  opts.apiKey = resolved.apiKey ?? "ollama";
  return opts;
}

function formatResponse(result: AssistantMessage, model: string): ChatCompletionResponse {
  const textContent = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(result.timestamp / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: textContent },
        finish_reason: STOP_REASON_MAP[result.stopReason] ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage.input,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.totalTokens,
    },
  };
}

export async function createCompletion(
  resolved: ResolvedModel,
  body: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const context = buildContext(body, resolved);
  const options = buildOptions(body, resolved);
  const result = await complete(resolved.model, context, options);
  return formatResponse(result, body.model);
}

export async function* createStreamingCompletion(
  resolved: ResolvedModel,
  body: ChatCompletionRequest,
): AsyncGenerator<string> {
  const context = buildContext(body, resolved);
  const options = buildOptions(body, resolved);
  const eventStream = stream(resolved.model, context, options);

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  function chunk(delta: Record<string, string>, finishReason: string | null): string {
    return JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }

  // First chunk: role announcement
  yield chunk({ role: "assistant" }, null);

  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      yield chunk({ content: event.delta }, null);
    } else if (event.type === "done") {
      const finishReason = STOP_REASON_MAP[event.reason] ?? "stop";
      yield chunk({}, finishReason);
    } else if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "Stream error");
    }
  }
}
