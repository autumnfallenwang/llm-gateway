import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "../src/errors";
import type { AssistantMessage, Context } from "../src/lib/pi";
import { ChatCompletionRequestSchema } from "../src/schemas/chat";

const completeMock = vi.fn();
const streamMock = vi.fn();

vi.mock("../src/lib/pi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi")>();
  return { ...actual, complete: completeMock, stream: streamMock, isContextOverflow: () => false };
});

const { createCompletion, createStreamingCompletion } = await import("../src/services/completion");

// ── Helpers ────────────────────────────────────────────────────────────────

type Api = "anthropic-messages" | "openai-completions";

function makeResolved(api: Api = "anthropic-messages") {
  return {
    model: {
      id: "test-model",
      name: "Test Model",
      api,
      provider: api === "anthropic-messages" ? "anthropic" : "ollama",
      baseUrl: "http://example.invalid",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    },
    provider: (api === "anthropic-messages" ? "anthropic" : "ollama") as "anthropic" | "ollama",
    capability: "chat" as const,
    apiKey: "test-key",
  };
}

function reply(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1700000000000,
    ...overrides,
  };
}

const LAB_TOOL = {
  type: "function" as const,
  function: {
    name: "get_latest_lab",
    description: "The signed-in patient's latest lab result by test name",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
};

const CALL = {
  id: "call_1",
  type: "function" as const,
  function: { name: "get_latest_lab", arguments: '{"name":"A1c"}' },
};

function request(body: Record<string, unknown>) {
  return ChatCompletionRequestSchema.parse({ model: "test-model", ...body });
}

async function contextFor(body: Record<string, unknown>, api: Api = "anthropic-messages") {
  completeMock.mockResolvedValue(reply());
  await createCompletion(makeResolved(api), request(body));
  const [, context, options] = completeMock.mock.calls[0] as [
    unknown,
    Context,
    Record<string, unknown>,
  ];
  return { context, options };
}

async function rejection(body: Record<string, unknown>): Promise<BackendError> {
  completeMock.mockResolvedValue(reply());
  const err = await createCompletion(makeResolved(), request(body)).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BackendError);
  return err as BackendError;
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Request schema ─────────────────────────────────────────────────────────

describe("request schema", () => {
  it("keeps tools, tool_choice and tool messages instead of dropping them", () => {
    const body = request({
      tools: [LAB_TOOL],
      tool_choice: "auto",
      messages: [
        { role: "user", content: "What was my last A1c?" },
        { role: "assistant", content: null, tool_calls: [CALL] },
        { role: "tool", tool_call_id: "call_1", content: "A1c 6.9% on 2026-09-28" },
      ],
    });
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  it("rejects a tool name the backends would refuse", () => {
    const bad = { ...LAB_TOOL, function: { ...LAB_TOOL.function, name: "get latest lab" } };
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "m",
      tools: [bad],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a tool message without tool_call_id", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "tool", content: "x" }],
    });
    expect(parsed.success).toBe(false);
  });
});

// ── OpenAI request → pi-ai context ─────────────────────────────────────────

describe("tools in the request", () => {
  it("passes tool definitions through", async () => {
    const { context } = await contextFor({
      tools: [LAB_TOOL],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(context.tools).toEqual([
      {
        name: "get_latest_lab",
        description: LAB_TOOL.function.description,
        parameters: LAB_TOOL.function.parameters,
      },
    ]);
  });

  it("gives a tool without parameters an empty object schema", async () => {
    const { context } = await contextFor({
      tools: [{ type: "function", function: { name: "ping" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(context.tools?.[0]).toEqual({
      name: "ping",
      description: "",
      parameters: { type: "object", properties: {} },
    });
  });

  it("sends no tools key when the request has none", async () => {
    const { context } = await contextFor({ messages: [{ role: "user", content: "hi" }] });
    expect(context).not.toHaveProperty("tools");
  });

  it("treats a developer message as the system prompt", async () => {
    const { context } = await contextFor({
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
    });
    expect(context.systemPrompt).toBe("Be brief.");
    expect(context.messages).toHaveLength(1);
  });
});

describe("a tool-call round trip", () => {
  it("turns assistant tool_calls into tool calls and tool messages into results", async () => {
    const { context } = await contextFor({
      tools: [LAB_TOOL],
      messages: [
        { role: "user", content: "What was my last A1c?" },
        { role: "assistant", content: null, tool_calls: [CALL] },
        { role: "tool", tool_call_id: "call_1", content: "A1c 6.9% on 2026-09-28" },
      ],
    });
    const [, assistant, result] = context.messages;
    expect(assistant).toMatchObject({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call_1", name: "get_latest_lab", arguments: { name: "A1c" } },
      ],
    });
    expect(result).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "get_latest_lab",
      content: [{ type: "text", text: "A1c 6.9% on 2026-09-28" }],
      isError: false,
    });
  });

  it("keeps the assistant's text alongside its tool calls", async () => {
    const { context } = await contextFor({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Let me check.", tool_calls: [CALL] },
        { role: "tool", tool_call_id: "call_1", content: "done" },
      ],
    });
    expect(context.messages[1].content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "call_1", name: "get_latest_lab", arguments: { name: "A1c" } },
    ]);
  });

  it("handles parallel calls answered by several tool messages", async () => {
    const second = { ...CALL, id: "call_2", function: { name: "get_vitals", arguments: "{}" } };
    const { context } = await contextFor({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", tool_calls: [CALL, second] },
        { role: "tool", tool_call_id: "call_1", content: "a" },
        { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "b" }] },
      ],
    });
    expect(context.messages.slice(2)).toMatchObject([
      { role: "toolResult", toolCallId: "call_1", toolName: "get_latest_lab" },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "get_vitals",
        content: [{ text: "b" }],
      },
    ]);
  });

  it("treats empty arguments as no arguments", async () => {
    const { context } = await contextFor({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", tool_calls: [{ ...CALL, function: { name: "ping", arguments: "" } }] },
        { role: "tool", tool_call_id: "call_1", content: "pong" },
      ],
    });
    expect(context.messages[1].content).toEqual([
      { type: "toolCall", id: "call_1", name: "ping", arguments: {} },
    ]);
  });

  it("refuses a tool message that answers no earlier call", async () => {
    const err = await rejection({
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "call_9", content: "?" },
      ],
    });
    expect(err.httpStatus).toBe(400);
    expect(err.errorCode).toBe("invalid_tool_call_id");
  });

  it("refuses arguments that aren't a JSON object", async () => {
    for (const args of ["{not json", "[1,2]", '"text"']) {
      const err = await rejection({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            tool_calls: [{ ...CALL, function: { name: "x", arguments: args } }],
          },
        ],
      });
      expect(err.httpStatus).toBe(400);
      expect(err.errorCode).toBe("invalid_tool_arguments");
    }
  });
});

describe("tool_choice", () => {
  const base = { tools: [LAB_TOOL], messages: [{ role: "user", content: "hi" }] };

  it("maps to Anthropic's names", async () => {
    for (const [choice, expected] of [
      ["auto", "auto"],
      ["none", "none"],
      ["required", "any"],
      [
        { type: "function", function: { name: "get_latest_lab" } },
        { type: "tool", name: "get_latest_lab" },
      ],
    ] as const) {
      const { options } = await contextFor({ ...base, tool_choice: choice });
      expect(options.toolChoice).toEqual(expected);
      vi.clearAllMocks();
    }
  });

  it("passes OpenAI's form through to OpenAI-compatible backends", async () => {
    const choice = { type: "function", function: { name: "get_latest_lab" } };
    const { options } = await contextFor({ ...base, tool_choice: choice }, "openai-completions");
    expect(options.toolChoice).toEqual(choice);
  });

  it("is ignored when there are no tools", async () => {
    const { options } = await contextFor({
      tool_choice: "required",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(options).not.toHaveProperty("toolChoice");
  });
});

// ── pi-ai response → OpenAI response ───────────────────────────────────────

describe("tool calls in the response", () => {
  it("returns tool_calls with JSON arguments and a null content", async () => {
    completeMock.mockResolvedValue(
      reply({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "toolu_1", name: "get_latest_lab", arguments: { name: "A1c" } },
        ],
      }),
    );
    const res = await createCompletion(
      makeResolved(),
      request({ tools: [LAB_TOOL], messages: [{ role: "user", content: "A1c?" }] }),
    );
    expect(res.choices[0].finish_reason).toBe("tool_calls");
    expect(res.choices[0].message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "get_latest_lab", arguments: '{"name":"A1c"}' },
        },
      ],
    });
  });

  it("streams a tool call as OpenAI chunks", async () => {
    const call = { type: "toolCall", id: "toolu_1", name: "get_latest_lab", arguments: {} };
    const partial = reply({ content: [call as never] });
    streamMock.mockReturnValue({
      // biome-ignore lint/suspicious/useAwait: async generator mirrors pi-ai's event stream
      async *[Symbol.asyncIterator]() {
        yield { type: "toolcall_start", contentIndex: 0, partial };
        yield { type: "toolcall_delta", contentIndex: 0, delta: '{"name":', partial };
        yield { type: "toolcall_delta", contentIndex: 0, delta: '"A1c"}', partial };
        yield { type: "done", reason: "toolUse", message: partial };
      },
    });
    const chunks: {
      choices: { delta: Record<string, unknown>; finish_reason: string | null }[];
    }[] = [];
    for await (const data of createStreamingCompletion(
      makeResolved(),
      request({ tools: [LAB_TOOL], messages: [{ role: "user", content: "A1c?" }], stream: true }),
    )) {
      chunks.push(JSON.parse(data));
    }
    const deltas = chunks.map((c) => c.choices[0].delta);
    expect(deltas[1]).toEqual({
      tool_calls: [
        {
          index: 0,
          id: "toolu_1",
          type: "function",
          function: { name: "get_latest_lab", arguments: "" },
        },
      ],
    });
    const args = deltas
      .slice(2, 4)
      .map((d) => (d.tool_calls as { function: { arguments: string } }[])[0].function.arguments)
      .join("");
    expect(JSON.parse(args)).toEqual({ name: "A1c" });
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });
});
