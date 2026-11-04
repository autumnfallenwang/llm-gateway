import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/lib/pi";
import type { ChatCompletionRequest } from "../src/routes/chat";
import type { ResolvedModel } from "../src/services/registry";

// ── Mocks ────────────────────────────────────────────────────────────────

const completeMock = vi.fn();
const resolveModelMock = vi.fn();
const loadImageMock = vi.fn();
const preprocessImageMock = vi.fn();

vi.mock("../src/lib/pi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi")>();
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
const { getModels } = await import("../src/lib/pi");
const { openDb, setDb } = await import("../src/lib/db");
const { log } = await import("../src/lib/logger");

// ── Helpers ──────────────────────────────────────────────────────────────

function makeResolved(
  overrides?: Partial<{
    provider: "ollama" | "anthropic" | "codex" | "deepseek";
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
    id: overrides?.id ?? "test-model",
    provider: overrides?.provider ?? "anthropic",
    capability: "chat",
    apiKey: overrides?.apiKey ?? "test-key",
  };
}

function makeVisionResolved(
  overrides?: Partial<{
    provider: "ollama" | "anthropic" | "codex" | "deepseek";
    id: string;
    apiKey: string;
  }>,
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    expect(resolveModelMock).toHaveBeenCalledWith("claude-haiku-5-5");
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
      if (id === "gpt-6-luna") return makeVisionResolved({ id, provider: "codex" });
      return undefined;
    });

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);

    await applyVisionFallback(body, makeResolved({ provider: "codex" }));

    expect(resolveModelMock).toHaveBeenCalledWith("gpt-6-luna");
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
    expect(resolveModelMock).toHaveBeenCalledWith("claude-haiku-5-5");
    expect(resolveModelMock).toHaveBeenCalledWith("qwen3-vl:8b");
  });

  it("falls through to general chain when family model lacks vision", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      // Family model exists but is text-only
      if (id === "claude-haiku-5-5") return makeResolved({ id });
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

    expect(resolveModelMock).toHaveBeenCalledWith("claude-haiku-5-5");
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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

    // In the image's place: after the text that came before it.
    expect(result.messages[0].content).toBe(
      "What is in this image?\n\n[Image description: A cat sitting on a table]",
    );
  });

  it("asks a reasoning fallback model not to reason", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    const haiku = getModels("anthropic").find((m) => m.id === "claude-haiku-5-5");
    resolveModelMock.mockImplementation((id: string) =>
      id === "claude-haiku-5-5" && haiku
        ? { model: haiku, provider: "anthropic", capability: "chat", apiKey: "vision-key" }
        : undefined,
    );

    const body = makeBody([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ]);
    await applyVisionFallback(body, makeResolved({ provider: "anthropic" }));

    const [, , options] = completeMock.mock.calls[0];
    expect(options).toMatchObject({ thinkingEnabled: false, apiKey: "vision-key" });
  });

  it("calls complete() with vision system prompt", async () => {
    setupImageMocks();
    completeMock.mockResolvedValue(makeAssistantMessage());
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      "Describe the image in detail, focusing on what the user's message asks about. Be factual and concise. Do not answer the user's question — just describe what is visible.",
    );
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("user");
    // The message's text, for focus, then the one image
    expect(context.messages[0].content).toEqual([
      { type: "text", text: "The user's message:\n\nDescribe" },
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
    loadImageMock.mockImplementation(async (url: string) => ({
      buffer: Buffer.from(url),
      mime: "image/jpeg",
    }));
    completeMock
      .mockResolvedValueOnce(makeAssistantMessage("First image description"))
      .mockResolvedValueOnce(makeAssistantMessage("Second image description"));
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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
      if (id === "claude-haiku-5-5") return makeVisionResolved({ id });
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

// ── One description per image, in its place, cached ──────────────────────

describe("applyVisionFallback: each image on its own", () => {
  const haikuOnly = (id: string) =>
    id === "claude-haiku-5-5" ? makeVisionResolved({ id }) : undefined;

  /** Each URL loads as different bytes (the URL itself), passed through preprocessing. */
  function distinctImages() {
    loadImageMock.mockImplementation(async (url: string) => ({
      buffer: Buffer.from(url),
      mime: "image/jpeg",
    }));
    preprocessImageMock.mockImplementation(async (loaded: { buffer: Buffer }) => ({
      buffer: loaded.buffer,
      mime: "image/jpeg",
      width: 8,
      height: 8,
    }));
  }

  type SentPart = { type: string; text?: string; data?: string };
  const sentParts = (call: unknown[]) =>
    (call[1] as { messages: { content: SentPart[] }[] }).messages[0]?.content ?? [];
  const sentImage = (call: unknown[]) => {
    const image = sentParts(call).find((p) => p.type === "image");
    return Buffer.from(image?.data ?? "", "base64").toString();
  };

  /** Answers each describe call with "described <the image's URL>". */
  function describeByUrl() {
    completeMock.mockImplementation(async (...call: unknown[]) =>
      makeAssistantMessage(`described ${sentImage(call)}`),
    );
  }

  const image = (url: string) => ({ type: "image_url" as const, image_url: { url } });

  it("puts each image's description where the image was, numbered, parts a blank line apart", async () => {
    distinctImages();
    describeByUrl();
    resolveModelMock.mockImplementation(haikuOnly);

    const body = makeBody([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these." },
          image("a.png"),
          { type: "text", text: "Which is bigger?" },
          image("b.png"),
        ],
      },
    ]);
    const result = await applyVisionFallback(body, makeResolved());

    expect(result.messages[0]?.content).toBe(
      [
        "Compare these.",
        "[Image 1 description: described a.png]",
        "Which is bigger?",
        "[Image 2 description: described b.png]",
      ].join("\n\n"),
    );
    expect(completeMock).toHaveBeenCalledTimes(2);
    const second = completeMock.mock.calls.find((c) => sentImage(c) === "b.png") ?? [];
    expect(sentParts(second).slice(0, 2)).toEqual([
      { type: "text", text: "The user's message:\n\nCompare these.\n\nWhich is bigger?" },
      { type: "text", text: "Describe image 2 of 2 in it." },
    ]);
  });

  it("describes the same image (with the same text) once per request", async () => {
    distinctImages();
    describeByUrl();
    resolveModelMock.mockImplementation(haikuOnly);

    const body = makeBody([
      { role: "user", content: [image("a.png")] },
      { role: "assistant", content: "A picture." },
      { role: "user", content: [image("a.png")] },
    ]);
    const result = await applyVisionFallback(body, makeResolved());

    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.messages[0]?.content).toBe("[Image description: described a.png]");
    expect(result.messages[2]?.content).toBe("[Image description: described a.png]");
  });

  it("describes at most 3 images at once", async () => {
    distinctImages();
    resolveModelMock.mockImplementation(haikuOnly);
    let active = 0;
    let most = 0;
    completeMock.mockImplementation(async (...call: unknown[]) => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeAssistantMessage(`described ${sentImage(call)}`);
    });

    const urls = ["1", "2", "3", "4", "5", "6", "7"].map((n) => `${n}.png`);
    const body = makeBody([{ role: "user", content: urls.map(image) }]);
    const result = await applyVisionFallback(body, makeResolved());

    expect(completeMock).toHaveBeenCalledTimes(7);
    expect(most).toBe(3);
    expect(result.messages[0]?.content).toContain("[Image 7 description: described 7.png]");
  });

  it("describes a DeepSeek model's images with deepseek-flash, not the general chain", async () => {
    distinctImages();
    describeByUrl();
    resolveModelMock.mockImplementation((id: string) =>
      id === "deepseek-flash" || id === "qwen3-vl:8b"
        ? makeVisionResolved({ id, provider: id === "deepseek-flash" ? "deepseek" : "ollama" })
        : undefined,
    );

    await applyVisionFallback(
      makeBody([{ role: "user", content: [image("a.png")] }]),
      makeResolved({ provider: "deepseek", id: "deepseek-v4-pro" }),
    );

    expect(resolveModelMock.mock.calls[0]?.[0]).toBe("deepseek-flash");
    expect((completeMock.mock.calls[0]?.[0] as { id: string }).id).toBe("deepseek-flash");
  });

  it("logs one vision.describe line: which model described, how many, what it cost", async () => {
    distinctImages();
    describeByUrl();
    resolveModelMock.mockImplementation(haikuOnly);
    const info = vi.spyOn(log, "info");

    await applyVisionFallback(
      makeBody([{ role: "user", content: [image("a.png"), image("b.png")] }]),
      makeResolved({ id: "text-only" }),
    );

    const line = info.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === "vision.describe",
    );
    expect(line?.[0]).toMatchObject({
      event: "vision.describe",
      model: "text-only",
      describer: "claude-haiku-5-5",
      images: 2,
      cached: 0,
      described: 2,
    });
    info.mockRestore();
  });

  describe("cache", () => {
    beforeEach(() => setDb(openDb(":memory:")));
    afterEach(() => setDb(undefined));

    const turn = (text: string) =>
      makeBody([{ role: "user", content: [{ type: "text", text }, image("a.png")] }]);

    it("describes an image once across turns: later requests read the stored text", async () => {
      distinctImages();
      describeByUrl();
      resolveModelMock.mockImplementation(haikuOnly);

      const first = await applyVisionFallback(turn("What is it?"), makeResolved());
      completeMock.mockResolvedValue(makeAssistantMessage("a different description"));
      const second = await applyVisionFallback(turn("What is it?"), makeResolved());

      expect(completeMock).toHaveBeenCalledTimes(1);
      expect(second.messages[0]?.content).toBe(first.messages[0]?.content);
    });

    it("keys by the message's text and the describing model", async () => {
      distinctImages();
      describeByUrl();
      resolveModelMock.mockImplementation(haikuOnly);
      await applyVisionFallback(turn("What is it?"), makeResolved());
      await applyVisionFallback(turn("What colour is it?"), makeResolved());
      expect(completeMock).toHaveBeenCalledTimes(2);

      resolveModelMock.mockImplementation((id: string) =>
        id === "gpt-6-luna" ? makeVisionResolved({ id, provider: "codex" }) : undefined,
      );
      await applyVisionFallback(turn("What is it?"), makeResolved({ provider: "codex" }));
      expect(completeMock).toHaveBeenCalledTimes(3);
    });

    it("doesn't store a failed description", async () => {
      distinctImages();
      resolveModelMock.mockImplementation(haikuOnly);
      completeMock.mockResolvedValueOnce({
        ...makeAssistantMessage(""),
        content: [],
        stopReason: "error",
        errorMessage: "overloaded",
      });
      const failed = await applyVisionFallback(turn("What is it?"), makeResolved());
      expect(failed.messages[0]?.content).toContain("(No description available)");

      completeMock.mockResolvedValueOnce(makeAssistantMessage("a cat"));
      const retried = await applyVisionFallback(turn("What is it?"), makeResolved());
      expect(completeMock).toHaveBeenCalledTimes(2);
      expect(retried.messages[0]?.content).toContain("[Image description: a cat]");
    });

    it("lets an entry expire after VISION_FALLBACK_CACHE_DAYS (30)", async () => {
      distinctImages();
      describeByUrl();
      resolveModelMock.mockImplementation(haikuOnly);
      const { getDb } = await import("../src/lib/db");

      await applyVisionFallback(turn("What is it?"), makeResolved());
      getDb()
        .raw.prepare("UPDATE image_descriptions SET created_at = ?")
        .run(Date.now() - 31 * 86_400_000);
      await applyVisionFallback(turn("What is it?"), makeResolved());

      expect(completeMock).toHaveBeenCalledTimes(2);
    });
  });
});
