import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "../src/routes/chat";
import type { ResolvedModel } from "../src/services/registry";

// ── Mocks ────────────────────────────────────────────────────────────────

const completeMock = vi.fn();
const resolveModelMock = vi.fn();
const loadImageMock = vi.fn();
const preprocessImageMock = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...actual, complete: completeMock };
});

vi.mock("../src/services/registry", () => ({
  resolveModel: resolveModelMock,
}));

vi.mock("../src/services/image/load", () => ({
  loadImage: loadImageMock,
  ImageLoadError: class ImageLoadError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ImageLoadError";
    }
  },
}));

vi.mock("../src/services/image/preprocess", () => ({
  preprocessImage: preprocessImageMock,
}));

// Import after mocks
const { applyVisionFallback, VisionFallbackError } = await import("../src/services/image/fallback");

// ── Helpers ──────────────────────────────────────────────────────────────

function makeResolved(
  overrides?: Partial<{
    provider: "ollama" | "anthropic" | "codex";
    apiKey: string;
    input: ("text" | "image")[];
    id: string;
  }>,
): ResolvedModel {
  return {
    model: {
      id: overrides?.id ?? "test-model",
      name: "Test Model",
      api: "anthropic-messages" as const,
      provider: "anthropic" as const,
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: overrides?.input ?? (["text"] as ("text" | "image")[]),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    },
    provider: overrides?.provider ?? "anthropic",
    apiKey: overrides?.apiKey ?? "test-key",
  };
}

function makeVisionResolved(
  overrides?: Partial<{ provider: "ollama" | "anthropic" | "codex"; id: string; apiKey: string }>,
): ResolvedModel {
  return makeResolved({
    input: ["text", "image"],
    id: overrides?.id ?? "vision-model",
    provider: overrides?.provider ?? "anthropic",
    apiKey: overrides?.apiKey ?? "vision-key",
  });
}

function makeAssistantMessage(text?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: text ?? "A cat sitting on a table" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "vision-model",
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
  };
}

function makeBody(messages: ChatCompletionRequest["messages"]): ChatCompletionRequest {
  return { model: "test-model", messages, stream: false };
}

function setupImageMocks() {
  loadImageMock.mockResolvedValue({
    buffer: Buffer.from("fake-image"),
    mime: "image/jpeg",
  });
  preprocessImageMock.mockResolvedValue({
    buffer: Buffer.from("processed"),
    mime: "image/jpeg",
    width: 800,
    height: 600,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("applyVisionFallback", () => {
  // ── Skip paths ───────────────────────────────────────────────────────

  it("returns body unchanged when model supports vision", async () => {
    const body = makeBody([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      },
    ]);
    const resolved = makeVisionResolved();

    const result = await applyVisionFallback(body, resolved);

    expect(result).toBe(body);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("returns body unchanged when no images in request", async () => {
    const body = makeBody([{ role: "user", content: "Hello there" }]);
    const resolved = makeResolved();

    const result = await applyVisionFallback(body, resolved);

    expect(result).toBe(body);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("returns body unchanged for text-only array content", async () => {
    const body = makeBody([
      {
        role: "user",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    ]);
    const resolved = makeResolved();

    const result = await applyVisionFallback(body, resolved);

    expect(result).toBe(body);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("skips non-user messages with array content", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "system",
        content: [{ type: "text", text: "You are helpful" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Previous reply" }],
      },
    ]);
    const resolved = makeResolved({ provider: "anthropic" });

    const result = await applyVisionFallback(body, resolved);

    // Only 1 complete() call for the user message
    expect(completeMock).toHaveBeenCalledTimes(1);
    // System and assistant messages preserved as-is
    expect(result.messages[0]).toEqual(body.messages[0]);
    expect(result.messages[2]).toEqual(body.messages[2]);
  });

  // ── Fallback model selection ─────────────────────────────────────────

  it("selects family model for anthropic provider", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(resolveModelMock).toHaveBeenCalledWith("claude-haiku-4-5");
  });

  it("selects family model for ollama provider", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "qwen3-vl:8b")
        return makeVisionResolved({
          id,
          provider: "ollama",
          apiKey: undefined as unknown as string,
        });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "ollama" }));

    expect(resolveModelMock).toHaveBeenCalledWith("qwen3-vl:8b");
  });

  it("maps codex provider to openai family", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "gpt-4o-mini") return makeVisionResolved({ id, provider: "codex" });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "codex" }));

    expect(resolveModelMock).toHaveBeenCalledWith("gpt-4o-mini");
  });

  it("falls through to general chain when family model not found", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    // Family model not found, first general chain model found
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "qwen3-vl:8b") return makeVisionResolved({ id, provider: "ollama" });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    // First tried family model, then general chain
    expect(resolveModelMock).toHaveBeenCalledWith("claude-haiku-4-5");
    expect(resolveModelMock).toHaveBeenCalledWith("qwen3-vl:8b");
  });

  it("falls through to general chain when family model lacks vision", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      // Family model exists but is text-only
      if (id === "claude-haiku-4-5") return makeResolved({ id });
      // General chain model has vision
      if (id === "qwen3-vl:8b") return makeVisionResolved({ id, provider: "ollama" });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(resolveModelMock).toHaveBeenCalledWith("claude-haiku-4-5");
    expect(resolveModelMock).toHaveBeenCalledWith("qwen3-vl:8b");
  });

  it("throws VisionFallbackError when no fallback model available", async () => {
    resolveModelMock.mockReturnValue(undefined);

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await expect(
      applyVisionFallback(body, makeResolved({ provider: "anthropic" })),
    ).rejects.toThrow(VisionFallbackError);

    await expect(
      applyVisionFallback(body, makeResolved({ provider: "anthropic" })),
    ).rejects.toThrow("No vision-capable fallback model available");
  });

  // ── Image description & replacement ──────────────────────────────────

  it("replaces image parts with text description", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage("A cat sitting on a table"));
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ]);

    const result = await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(result.messages[0].content).toBe(
      "[Image description: A cat sitting on a table]\n\nWhat is in this image?",
    );
  });

  it("calls complete() with vision system prompt", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    const [, context] = completeMock.mock.calls[0];
    expect(context.systemPrompt).toBe(
      "Describe the image(s) in detail, focusing on what the user is asking about. Be factual and concise. Do not answer the user's question — just describe what is visible.",
    );
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("user");
    // Content should include text + image parts
    expect(context.messages[0].content).toEqual([
      { type: "text", text: "Describe" },
      {
        type: "image",
        data: Buffer.from("processed").toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);
  });

  it("loads and preprocesses images for vision call", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://example.com/img.png", detail: "low" },
          },
        ],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(loadImageMock).toHaveBeenCalledWith("https://example.com/img.png");
    expect(preprocessImageMock).toHaveBeenCalledWith(
      { buffer: Buffer.from("fake-image"), mime: "image/jpeg" },
      "low",
    );
  });

  it("handles image-only message (no original text)", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage("A landscape photo"));
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    const result = await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    // No trailing text, just the description
    expect(result.messages[0].content).toBe("[Image description: A landscape photo]");
  });

  it("truncates long descriptions", async () => {
    setupImageMocks();
    const longText = "A".repeat(1500);
    completeMock.mockResolvedValue(makeAssistantMessage(longText));
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    const result = await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));
    const content = result.messages[0].content as string;

    // Description should be truncated at 1000 chars + "..."
    expect(content).toBe(`[Image description: ${"A".repeat(1000)}...]`);
  });

  it("returns fallback text for empty vision response", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue({
      ...makeAssistantMessage(),
      content: [],
    });
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    const result = await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(result.messages[0].content).toBe("[Image description: (No description available)]");
  });

  it("processes multiple user messages independently", async () => {
    setupImageMocks();
    completeMock
      .mockResolvedValueOnce(makeAssistantMessage("First image description"))
      .mockResolvedValueOnce(makeAssistantMessage("Second image description"));
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      },
      { role: "assistant", content: "I see" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/b.png" } }],
      },
    ]);

    const result = await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(result.messages[0].content).toContain("First image description");
    expect(result.messages[2].content).toContain("Second image description");
  });

  it("preserves system and assistant messages untouched", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const systemMsg = { role: "system" as const, content: "Be helpful" };
    const assistantMsg = { role: "assistant" as const, content: "I understand" };
    const body = makeBody([
      systemMsg,
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
      assistantMsg,
    ]);

    const result = await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(result.messages[0]).toBe(systemMsg);
    expect(result.messages[2]).toBe(assistantMsg);
  });

  // ── Error handling ───────────────────────────────────────────────────

  it("wraps vision model errors as VisionFallbackError", async () => {
    setupImageMocks();
    completeMock.mockRejectedValue(new Error("API rate limit exceeded"));
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await expect(
      applyVisionFallback(body, makeResolved({ provider: "anthropic" })),
    ).rejects.toThrow(VisionFallbackError);

    await expect(
      applyVisionFallback(body, makeResolved({ provider: "anthropic" })),
    ).rejects.toThrow("Vision fallback model failed: API rate limit exceeded");
  });

  it("lets ImageLoadError propagate unwrapped", async () => {
    const { ImageLoadError } = await import("../src/services/image/load");
    loadImageMock.mockRejectedValue(new ImageLoadError("Failed to fetch image"));
    preprocessImageMock.mockResolvedValue({
      buffer: Buffer.from("processed"),
      mime: "image/jpeg",
      width: 800,
      height: 600,
    });
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-4-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    const error = await applyVisionFallback(body, makeResolved({ provider: "anthropic" })).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(ImageLoadError);
    expect(error.name).toBe("ImageLoadError");
    expect(error).not.toBeInstanceOf(VisionFallbackError);
  });
});
