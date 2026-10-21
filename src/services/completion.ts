import { DEFAULT_SYSTEM_PROMPT, OLLAMA_NUM_CTX } from "../config.js";
import { BackendError } from "../errors.js";
import { log } from "../lib/logger.js";
import {
  type AssistantMessage,
  type Context,
  complete,
  type ImageContent,
  isContextOverflow,
  type Message,
  stream,
  type TextContent,
  type Tool,
  type ToolCall,
  type Usage,
} from "../lib/pi.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../routes/chat.js";
import type { ChatMessage, ChatTool, ChatToolChoice, ContentPart } from "../schemas/chat.js";
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
// The provider SDKs prefix API errors with the HTTP status: `400 {"type":"error",...}`.
const BAD_REQUEST_PATTERN = /^400\b|invalid_request_error/;

function throwIfBackendError(result: AssistantMessage): void {
  if (result.stopReason !== "error") return;

  const msg = result.errorMessage ?? "Unknown backend error";
  log.warn(
    {
      event: "completion.backend_error",
      provider: result.provider,
      model: result.model,
      err_message: msg.slice(0, 2000),
    },
    "Backend call failed",
  );

  if (isContextOverflow(result)) {
    throw new BackendError(msg, 400, "invalid_request_error", "context_length_exceeded");
  }
  if (RATE_LIMIT_PATTERN.test(msg)) {
    throw new BackendError(msg, 429, "rate_limit_exceeded", "rate_limit_exceeded");
  }
  if (BAD_REQUEST_PATTERN.test(msg)) {
    throw new BackendError(msg, 400, "invalid_request_error", "invalid_input");
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

function invalidRequest(message: string, code: string, cause?: unknown): BackendError {
  return new BackendError(message, 400, "invalid_request_error", code, { cause });
}

type AssistantChatMessage = Extract<ChatMessage, { role: "assistant" }>;
type RequestToolCall = NonNullable<AssistantChatMessage["tool_calls"]>[number];

function parseToolArguments(call: RequestToolCall): ToolCall["arguments"] {
  const raw = call.function.arguments.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw invalidRequest(
      `tool call '${call.id}' has arguments that aren't valid JSON`,
      "invalid_tool_arguments",
      err,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidRequest(
      `tool call '${call.id}' arguments must be a JSON object`,
      "invalid_tool_arguments",
    );
  }
  return parsed as ToolCall["arguments"];
}

function toTool(tool: ChatTool): Tool {
  return {
    name: tool.function.name,
    description: tool.function.description ?? "",
    // JSON Schema at runtime; pi-ai types it as a TypeBox schema.
    parameters: (tool.function.parameters ?? {
      type: "object",
      properties: {},
    }) as Tool["parameters"],
  };
}

type ToolChatMessage = Extract<ChatMessage, { role: "tool" }>;

function toAssistantMessage(
  msg: AssistantChatMessage,
  resolved: ResolvedModel,
  toolNames: Map<string, string>,
): Message {
  const text = msg.content == null ? "" : extractTextContent(msg.content);
  const calls = msg.tool_calls ?? [];
  const content: (TextContent | ToolCall)[] = [];
  if (text || calls.length === 0) content.push({ type: "text", text });
  for (const call of calls) {
    toolNames.set(call.id, call.function.name);
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.function.name,
      arguments: parseToolArguments(call),
    });
  }
  return {
    role: "assistant",
    content,
    api: resolved.model.api,
    provider: resolved.model.provider,
    model: resolved.model.id,
    usage: EMPTY_USAGE,
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function toToolResult(msg: ToolChatMessage, toolNames: Map<string, string>): Message {
  const toolName = toolNames.get(msg.tool_call_id);
  if (!toolName) {
    throw invalidRequest(
      `tool message answers '${msg.tool_call_id}', which no earlier assistant message called`,
      "invalid_tool_call_id",
    );
  }
  return {
    role: "toolResult",
    toolCallId: msg.tool_call_id,
    toolName,
    content: [{ type: "text", text: extractTextContent(msg.content) }],
    isError: false,
    timestamp: Date.now(),
  };
}

async function buildContext(
  body: ChatCompletionRequest,
  resolved: ResolvedModel,
): Promise<Context> {
  let systemPrompt: string | undefined;
  const messages: Message[] = [];
  // A tool result names only the call it answers; the backends also want the tool's name.
  const toolNames = new Map<string, string>();

  for (const msg of body.messages) {
    if (msg.role === "system" || msg.role === "developer") {
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
      messages.push(toAssistantMessage(msg, resolved, toolNames));
    } else {
      messages.push(toToolResult(msg, toolNames));
    }
  }

  // Codex API requires instructions (system prompt) to be present
  if (!systemPrompt && resolved.provider === "codex") {
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  const tools = body.tools?.map(toTool);
  return { systemPrompt, messages, ...(tools?.length ? { tools } : {}) };
}

/** The single tool a forced tool_choice comes down to, if it comes down to one. */
function forcedToolName(choice: ChatToolChoice, tools: ChatTool[]): string | undefined {
  if (typeof choice === "object") return choice.function.name;
  return choice === "required" && tools.length === 1 ? tools[0]?.function.name : undefined;
}

/**
 * Why a backend can't take a forced tool_choice as a parameter, or undefined when it can.
 * Ollama ignores tool_choice. Anthropic accepts only "auto" or "none" while a model
 * thinks, and Sonnet 5.5, Opus 5.5 and Fable 5/5.1 can't stop (`thinkingLevelMap.off`
 * is null); the other thinking Claude models get thinking turned off instead.
 */
function cannotForce(model: ResolvedModel["model"]): string | undefined {
  if (model.provider === "ollama") return "Ollama ignores tool_choice";
  if (
    model.api === "anthropic-messages" &&
    model.reasoning &&
    model.thinkingLevelMap?.off === null
  ) {
    return `model '${model.id}' always thinks, and Anthropic won't force a tool while a model thinks`;
  }
  return undefined;
}

/**
 * Applies tool_choice to the call, as each backend can honour it (all checked live):
 * - A forced single tool (a named function, or "required" with one tool) is offered on
 *   its own. With only that tool, Anthropic's "any" pins the call; a named Anthropic
 *   tool_choice alone was ignored by Opus 5 and Haiku 5.5. Where the choice can't be
 *   sent (see cannotForce), the system prompt asks for the tool instead: 24/24 calls on
 *   the always-thinking Claude models, 6/6 on gemma4 and qwen3.
 * - "required" over several tools goes to Anthropic as "any"; where it can't be sent,
 *   asking in words got 14/24 (Claude) and 3/6 (Ollama), so it's a 400.
 * - "none" withholds the tools from Ollama, which otherwise calls them anyway.
 */
function withToolChoice(
  body: ChatCompletionRequest,
  resolved: ResolvedModel,
  context: Context,
  options: Record<string, unknown>,
): { context: Context; options: Record<string, unknown> } {
  const tools = body.tools ?? [];
  const choice = body.tool_choice;
  // Codex has never been sent tool_choice; it's disabled on the cluster, so leave it be.
  if (tools.length === 0 || !choice || resolved.model.api === "openai-codex-responses") {
    return { context, options };
  }
  if (typeof choice === "object" && !tools.some((t) => t.function.name === choice.function.name)) {
    throw invalidRequest(
      `tool_choice names '${choice.function.name}', which isn't one of the request's tools`,
      "invalid_tool_choice",
    );
  }

  const { model } = resolved;
  const anthropic = model.api === "anthropic-messages";
  if (choice === "auto" || choice === "none") {
    if (choice === "none" && model.provider === "ollama") {
      return { context: { ...context, tools: undefined }, options };
    }
    return { context, options: { ...options, toolChoice: choice } };
  }

  const name = forcedToolName(choice, tools);
  const pinned = name
    ? { ...context, tools: context.tools?.filter((t) => t.name === name) }
    : context;
  const reason = cannotForce(model);
  if (reason) {
    if (!name) {
      throw invalidRequest(
        `${reason}, and asking for "one of several tools" in words isn't reliable; name the tool in tool_choice or use "auto"`,
        "unsupported_tool_choice",
      );
    }
    const instruction = `You must respond by calling the \`${name}\` tool. Do not reply with text alone.`;
    const systemPrompt = pinned.systemPrompt
      ? `${pinned.systemPrompt}\n\n${instruction}`
      : instruction;
    return {
      context: { ...pinned, systemPrompt },
      options: anthropic ? { ...options, toolChoice: "auto" } : options,
    };
  }
  if (anthropic) {
    const thinkingOff = model.reasoning ? { thinkingEnabled: false } : {};
    return { context: pinned, options: { ...options, ...thinkingOff, toolChoice: "any" } };
  }
  return { context, options: { ...options, toolChoice: choice } };
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
  const { context, options } = withToolChoice(
    body,
    resolved,
    await buildContext(effectiveBody, resolved),
    buildOptions(body, resolved),
  );
  const result = await complete(resolved.model, context, options);
  throwIfBackendError(result);
  return formatResponse(result, body.model);
}

export async function* createStreamingCompletion(
  resolved: ResolvedModel,
  body: ChatCompletionRequest,
): AsyncGenerator<string> {
  const effectiveBody = await applyVisionFallback(body, resolved);
  const { context, options } = withToolChoice(
    body,
    resolved,
    await buildContext(effectiveBody, resolved),
    buildOptions(body, resolved),
  );
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
