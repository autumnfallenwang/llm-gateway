import {
  type AssistantMessage,
  type Context,
  complete,
  type ImageContent,
  isContextOverflow,
  type Message,
  stream,
  type TextContent,
  type Usage,
} from "@mariozechner/pi-ai";
import { DEFAULT_SYSTEM_PROMPT, OLLAMA_NUM_CTX } from "../config.js";
import { BackendError } from "../errors.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../routes/chat.js";
import type { ContentPart } from "../schemas/chat.js";
import { applyVisionFallback } from "./image/fallback.js";
import { loadImage } from "./image/load.js";
import { preprocessImage } from "./image/preprocess.js";
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

const RATE_LIMIT_PATTERN = /rate.limit|usage.limit|too many requests|429/i;

function throwIfBackendError(result: AssistantMessage): void {
  if (result.stopReason !== "error") return;

  const msg = result.errorMessage ?? "Unknown backend error";

  if (isContextOverflow(result)) {
    throw new BackendError(msg, 400, "invalid_request_error", "context_length_exceeded");
  }
  if (RATE_LIMIT_PATTERN.test(msg)) {
    throw new BackendError(msg, 429, "rate_limit_exceeded", "rate_limit_exceeded");
  }
  throw new BackendError(msg, 500, "server_error", "server_error");
}

function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

async function processImagePart(
  url: string,
  detail?: "auto" | "low" | "high",
): Promise<ImageContent> {
  const loaded = await loadImage(url);
  const processed = await preprocessImage(loaded, detail);
  return {
    type: "image",
    data: processed.buffer.toString("base64"),
    mimeType: processed.mime,
  };
}

async function buildContext(
  body: ChatCompletionRequest,
  resolved: ResolvedModel,
): Promise<Context> {
  let systemPrompt: string | undefined;
  const messages: Message[] = [];

  for (const msg of body.messages) {
    if (msg.role === "system") {
      systemPrompt ??= extractTextContent(msg.content);
      continue;
    }

    if (msg.role === "user") {
      let content: string | (TextContent | ImageContent)[];
      if (typeof msg.content === "string") {
        content = msg.content;
      } else {
        content = await Promise.all(
          msg.content.map(async (p) => {
            if (p.type === "text") {
              return { type: "text" as const, text: p.text } satisfies TextContent;
            }
            return await processImagePart(p.image_url.url, p.image_url.detail);
          }),
        );
      }
      messages.push({
        role: "user",
        content,
        timestamp: Date.now(),
      });
    } else if (msg.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: extractTextContent(msg.content) }],
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
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
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

  if (resolved.provider === "ollama") {
    opts.onPayload = (payload: Record<string, unknown>) => {
      payload.options = { num_ctx: OLLAMA_NUM_CTX };
    };
  }

  return opts;
}

function formatResponse(result: AssistantMessage, model: string): ChatCompletionResponse {
  const textContent = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  const toolCalls = result.content
    .filter((c) => c.type === "toolCall")
    .map((c) => ({
      id: (c as { id: string }).id,
      type: "function" as const,
      function: {
        name: (c as { name: string }).name,
        arguments: JSON.stringify((c as { arguments: unknown }).arguments),
      },
    }));

  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls.length > 0 && !textContent ? null : textContent,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(result.timestamp / 1000),
    model,
    choices: [
      {
        index: 0,
        message: message as { role: "assistant"; content: string | null },
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
  const effectiveBody = await applyVisionFallback(body, resolved);
  const context = await buildContext(effectiveBody, resolved);
  const options = buildOptions(body, resolved);
  const result = await complete(resolved.model, context, options);
  throwIfBackendError(result);
  return formatResponse(result, body.model);
}

export async function* createStreamingCompletion(
  resolved: ResolvedModel,
  body: ChatCompletionRequest,
): AsyncGenerator<string> {
  const effectiveBody = await applyVisionFallback(body, resolved);
  const context = await buildContext(effectiveBody, resolved);
  const options = buildOptions(body, resolved);
  const eventStream = stream(resolved.model, context, options);

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
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

  let toolCallIndex = -1;

  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      yield chunk({ content: event.delta }, null);
    } else if (event.type === "thinking_delta") {
      yield chunk({ reasoning: (event as { delta: string }).delta }, null);
    } else if (event.type === "toolcall_start") {
      toolCallIndex++;
      const partial = (
        event as { partial?: { content?: { id?: string; name?: string }[] }; contentIndex?: number }
      ).partial;
      const contentIndex = (event as { contentIndex?: number }).contentIndex ?? 0;
      const tc = partial?.content?.[contentIndex] as { id?: string; name?: string } | undefined;
      yield chunk(
        {
          tool_calls: [
            {
              index: toolCallIndex,
              id: tc?.id ?? "",
              type: "function",
              function: { name: tc?.name ?? "", arguments: "" },
            },
          ],
        },
        null,
      );
    } else if (event.type === "toolcall_delta") {
      yield chunk(
        {
          tool_calls: [
            {
              index: toolCallIndex,
              function: { arguments: (event as { delta: string }).delta },
            },
          ],
        },
        null,
      );
    } else if (event.type === "done") {
      const finishReason = STOP_REASON_MAP[event.reason] ?? "stop";
      yield chunk({}, finishReason);
    } else if (event.type === "error") {
      throwIfBackendError(event.error);
    }
  }
}
