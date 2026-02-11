import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...actual, complete: completeMock };
});

// Import after mock is set up
const { createCompletion } = await import("../src/services/completion");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeResolved(overrides?: Partial<{ apiKey: string }>) {
  return {
    model: {
      id: "test-model",
      name: "Test Model",
      api: "anthropic-messages" as const,
      provider: "anthropic" as const,
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    },
    provider: "anthropic" as const,
    apiKey: overrides?.apiKey ?? "test-key",
  };
}

function makeAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello from pi-ai" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1700000000000,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createCompletion", () => {
  it("converts simple user message", async () => {
    completeMock.mockResolvedValue(makeAssistantMessage());

    await createCompletion(makeResolved(), {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    });

    const [, context] = completeMock.mock.calls[0];
    expect(context.systemPrompt).toBeUndefined();
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("user");
    expect(context.messages[0].content).toBe("Hello");
  });

  it("extracts system prompt", async () => {
    completeMock.mockResolvedValue(makeAssistantMessage());

    await createCompletion(makeResolved(), {
      model: "test-model",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
      stream: false,
    });

    const [, context] = completeMock.mock.calls[0];
    expect(context.systemPrompt).toBe("You are helpful");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("user");
  });

  it("handles multi-turn conversation", async () => {
    completeMock.mockResolvedValue(makeAssistantMessage());

    await createCompletion(makeResolved(), {
      model: "test-model",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ],
      stream: false,
    });

    const [, context]: [unknown, Context] = completeMock.mock.calls[0];
    expect(context.messages).toHaveLength(3);
    expect(context.messages[0].role).toBe("user");
    expect(context.messages[1].role).toBe("assistant");
    expect(context.messages[2].role).toBe("user");
  });

  it("passes temperature and maxTokens", async () => {
    completeMock.mockResolvedValue(makeAssistantMessage());

    await createCompletion(makeResolved(), {
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.7,
      max_tokens: 100,
      stream: false,
    });

    const [, , options] = completeMock.mock.calls[0];
    expect(options.temperature).toBe(0.7);
    expect(options.maxTokens).toBe(100);
    expect(options.apiKey).toBe("test-key");
  });

  it("uses 'ollama' apiKey when no key provided", async () => {
    completeMock.mockResolvedValue(makeAssistantMessage());

    const resolved = { ...makeResolved(), apiKey: undefined };
    await createCompletion(resolved, {
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    });

    const [, , options] = completeMock.mock.calls[0];
    expect(options.apiKey).toBe("ollama");
  });

  it("maps response fields correctly", async () => {
    completeMock.mockResolvedValue(makeAssistantMessage());

    const response = await createCompletion(makeResolved(), {
      model: "my-model",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    });

    expect(response.id).toMatch(/^chatcmpl-/);
    expect(response.object).toBe("chat.completion");
    expect(response.created).toBe(1700000000);
    expect(response.model).toBe("my-model");
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].index).toBe(0);
    expect(response.choices[0].message.role).toBe("assistant");
    expect(response.choices[0].message.content).toBe("Hello from pi-ai");
    expect(response.choices[0].finish_reason).toBe("stop");
    expect(response.usage.prompt_tokens).toBe(10);
    expect(response.usage.completion_tokens).toBe(20);
    expect(response.usage.total_tokens).toBe(30);
  });

  it("maps stopReason correctly", async () => {
    for (const [piaiReason, expected] of [
      ["stop", "stop"],
      ["length", "length"],
      ["toolUse", "tool_calls"],
      ["error", "stop"],
    ] as const) {
      completeMock.mockResolvedValue(makeAssistantMessage({ stopReason: piaiReason }));

      const response = await createCompletion(makeResolved(), {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(response.choices[0].finish_reason).toBe(expected);
    }
  });

  it("handles empty content gracefully", async () => {
    completeMock.mockResolvedValue(makeAssistantMessage({ content: [] }));

    const response = await createCompletion(makeResolved(), {
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    });

    expect(response.choices[0].message.content).toBe("");
  });
});
