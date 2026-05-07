import { describe, expect, it, vi } from "vitest";

const MOCK_ASSISTANT_MESSAGE = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "Mock response" }],
  api: "openai-completions" as const,
  provider: "ollama",
  model: "test-model",
  usage: {
    input: 5,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: 1700000000000,
};

function createMockEventStream() {
  const events = [
    { type: "text_delta", contentIndex: 0, delta: "Mock ", partial: MOCK_ASSISTANT_MESSAGE },
    { type: "text_delta", contentIndex: 0, delta: "response", partial: MOCK_ASSISTANT_MESSAGE },
    { type: "done", reason: "stop", message: MOCK_ASSISTANT_MESSAGE },
  ];
  return {
    // biome-ignore lint/suspicious/useAwait: async needed to produce AsyncGenerator for pi-ai stream interface
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    result: () => Promise.resolve(MOCK_ASSISTANT_MESSAGE),
  };
}

const isContextOverflowMock = vi.fn().mockReturnValue(false);

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: vi.fn().mockResolvedValue(MOCK_ASSISTANT_MESSAGE),
    stream: vi.fn().mockImplementation(() => createMockEventStream()),
    isContextOverflow: isContextOverflowMock,
  };
});

vi.mock("../src/lib/ollama", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ollama")>();
  return {
    ...actual,
    fetchOllamaModels: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../src/services/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/validation")>();
  return {
    ...actual,
    readValidationReport: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../src/services/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/registry")>();
  return {
    ...actual,
    resolveModel: vi.fn(actual.resolveModel),
  };
});

// Must import after vi.mock
const { default: app } = await import("../src/app");

const VALID_BODY = {
  model: "gpt-3.5-turbo",
  messages: [{ role: "user", content: "Hello" }],
};

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Health check", () => {
  it("GET / returns status ok", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.name).toBe("llm-gateway");
  });
});

describe("OpenAPI", () => {
  it("GET /openapi.json returns spec", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBe("3.1.0");
    expect(json.info.title).toBe("LLM Gateway");
  });
});

describe("POST /v1/chat/completions", () => {
  it("rejects missing model", async () => {
    const res = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error).toHaveProperty("param");
    expect(json.error).toHaveProperty("code");
  });

  it("rejects empty messages array", async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-3.5-turbo",
      messages: [],
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.param).toBe("messages");
  });

  it("rejects temperature > 2", async () => {
    const res = await post("/v1/chat/completions", {
      ...VALID_BODY,
      temperature: 3,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.param).toBe("temperature");
  });

  it("stream=true returns SSE response", async () => {
    // Mock resolveModel to return a valid model for this test
    const { resolveModel } = await import("../src/services/registry");
    vi.mocked(resolveModel).mockReturnValueOnce({
      model: {
        id: "test",
        name: "test",
        api: "openai-completions",
        provider: "ollama",
        baseUrl: "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 4096,
      },
      provider: "ollama",
      capability: "chat",
    });

    const res = await post("/v1/chat/completions", {
      ...VALID_BODY,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(lines.length).toBeGreaterThanOrEqual(3); // role + text chunks + finish + [DONE]

    // First data line should have role
    const first = JSON.parse(lines[0].replace("data: ", ""));
    expect(first.object).toBe("chat.completion.chunk");
    expect(first.choices[0].delta.role).toBe("assistant");

    // Last data line should be [DONE]
    expect(lines[lines.length - 1]).toBe("data: [DONE]");
  });

  it("returns 404 for unknown model", async () => {
    const res = await post("/v1/chat/completions", VALID_BODY);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.code).toBe("model_not_found");
    expect(json.error.param).toBe("model");
  });

  it("accepts content as array of text content parts", async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });
    // 404 = schema passed, model lookup failed (expected)
    expect(res.status).toBe(404);
  });

  it("accepts image_url content part", async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/img.png", detail: "auto" },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(404);
  });

  it("rejects empty content array", async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: [] }],
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
  });

  it("rejects invalid content part type", async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: [{ type: "audio", data: "abc" }],
        },
      ],
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
  });
});

describe("GET /v1/models", () => {
  it("returns models list shape with status fields", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
    for (const model of json.data) {
      expect(model).toHaveProperty("status");
      expect(model).toHaveProperty("status_detail");
      expect(model).toHaveProperty("validated_at");
    }
  });

  it("returns context_window and max_tokens for each model", async () => {
    const { loadRegistry } = await import("../src/services/registry");
    const { fetchOllamaModels } = await import("../src/lib/ollama");
    vi.mocked(fetchOllamaModels).mockResolvedValueOnce([
      {
        model: {
          id: "test-model",
          name: "test-model",
          api: "openai-completions",
          provider: "ollama",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
        capabilities: { supportsVision: false, supportsEmbedding: false, supportsCompletion: true },
      },
    ]);
    await loadRegistry();

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = await res.json();
    const model = json.data.find((m: { id: string }) => m.id === "test-model");
    expect(model).toBeDefined();
    expect(model.context_window).toBe(8192);
    expect(model.max_tokens).toBe(2048);
  });

  it("enriches models with validation status from report", async () => {
    const { loadRegistry } = await import("../src/services/registry");
    const { fetchOllamaModels } = await import("../src/lib/ollama");
    const { readValidationReport } = await import("../src/services/validation");

    vi.mocked(fetchOllamaModels).mockResolvedValueOnce([
      {
        model: {
          id: "good-model",
          name: "good-model",
          api: "openai-completions",
          provider: "ollama",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 4096,
        },
        capabilities: { supportsVision: false, supportsEmbedding: false, supportsCompletion: true },
      },
      {
        model: {
          id: "bad-model",
          name: "bad-model",
          api: "openai-completions",
          provider: "ollama",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 4096,
        },
        capabilities: { supportsVision: false, supportsEmbedding: false, supportsCompletion: true },
      },
    ]);
    await loadRegistry();

    vi.mocked(readValidationReport).mockResolvedValueOnce({
      validatedAt: "2026-01-15T10:00:00.000Z",
      models: {
        "good-model": { status: "ok", latencyMs: 100 },
        "bad-model": { status: "error", error: "connection refused" },
      },
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = await res.json();

    const good = json.data.find((m: { id: string }) => m.id === "good-model");
    expect(good.status).toBe("ok");
    expect(good.status_detail).toBeNull();
    expect(good.validated_at).toBe("2026-01-15T10:00:00.000Z");

    const bad = json.data.find((m: { id: string }) => m.id === "bad-model");
    expect(bad.status).toBe("error");
    expect(bad.status_detail).toBe("connection refused");
    expect(bad.validated_at).toBe("2026-01-15T10:00:00.000Z");
  });

  it("returns status 'unknown' when no validation report exists", async () => {
    const { loadRegistry } = await import("../src/services/registry");
    const { fetchOllamaModels } = await import("../src/lib/ollama");
    const { readValidationReport } = await import("../src/services/validation");

    vi.mocked(fetchOllamaModels).mockResolvedValueOnce([
      {
        model: {
          id: "some-model",
          name: "some-model",
          api: "openai-completions",
          provider: "ollama",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 4096,
        },
        capabilities: { supportsVision: false, supportsEmbedding: false, supportsCompletion: true },
      },
    ]);
    await loadRegistry();

    vi.mocked(readValidationReport).mockResolvedValueOnce(null);

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = await res.json();
    const model = json.data.find((m: { id: string }) => m.id === "some-model");
    expect(model.status).toBe("unknown");
    expect(model.status_detail).toBeNull();
    expect(model.validated_at).toBeNull();
  });

  it("returns status 'unknown' for models not in validation report", async () => {
    const { loadRegistry } = await import("../src/services/registry");
    const { fetchOllamaModels } = await import("../src/lib/ollama");
    const { readValidationReport } = await import("../src/services/validation");

    vi.mocked(fetchOllamaModels).mockResolvedValueOnce([
      {
        model: {
          id: "known-model",
          name: "known-model",
          api: "openai-completions",
          provider: "ollama",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 4096,
        },
        capabilities: { supportsVision: false, supportsEmbedding: false, supportsCompletion: true },
      },
      {
        model: {
          id: "new-model",
          name: "new-model",
          api: "openai-completions",
          provider: "ollama",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 4096,
        },
        capabilities: { supportsVision: false, supportsEmbedding: false, supportsCompletion: true },
      },
    ]);
    await loadRegistry();

    vi.mocked(readValidationReport).mockResolvedValueOnce({
      validatedAt: "2026-01-15T10:00:00.000Z",
      models: {
        "known-model": { status: "ok", latencyMs: 50 },
      },
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = await res.json();

    const known = json.data.find((m: { id: string }) => m.id === "known-model");
    expect(known.status).toBe("ok");
    expect(known.validated_at).toBe("2026-01-15T10:00:00.000Z");

    const newModel = json.data.find((m: { id: string }) => m.id === "new-model");
    expect(newModel.status).toBe("unknown");
    expect(newModel.status_detail).toBeNull();
    expect(newModel.validated_at).toBe("2026-01-15T10:00:00.000Z");
  });
});

describe("Backend error responses", () => {
  const MOCK_MODEL = {
    model: {
      id: "test",
      name: "test",
      api: "openai-completions" as const,
      provider: "ollama",
      baseUrl: "",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 4096,
    },
    provider: "ollama" as const,
    capability: "chat" as const,
  };

  async function mockResolveModel() {
    const { resolveModel } = await import("../src/services/registry");
    vi.mocked(resolveModel).mockReturnValueOnce(MOCK_MODEL);
  }

  it("returns 400 for context overflow errors", async () => {
    await mockResolveModel();
    const { complete } = await import("@mariozechner/pi-ai");
    vi.mocked(complete).mockResolvedValueOnce({
      ...MOCK_ASSISTANT_MESSAGE,
      stopReason: "error",
      errorMessage: "prompt is too long: 10000 tokens > 4096 maximum",
    });
    isContextOverflowMock.mockReturnValueOnce(true);

    const res = await post("/v1/chat/completions", VALID_BODY);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.code).toBe("context_length_exceeded");
    expect(json.error.message).toContain("prompt is too long");
  });

  it("returns 429 for rate limit errors", async () => {
    await mockResolveModel();
    const { complete } = await import("@mariozechner/pi-ai");
    vi.mocked(complete).mockResolvedValueOnce({
      ...MOCK_ASSISTANT_MESSAGE,
      stopReason: "error",
      errorMessage: "Rate limit exceeded",
    });
    isContextOverflowMock.mockReturnValueOnce(false);

    const res = await post("/v1/chat/completions", VALID_BODY);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.type).toBe("rate_limit_exceeded");
    expect(json.error.code).toBe("rate_limit_exceeded");
  });

  it("returns 500 for generic backend errors", async () => {
    await mockResolveModel();
    const { complete } = await import("@mariozechner/pi-ai");
    vi.mocked(complete).mockResolvedValueOnce({
      ...MOCK_ASSISTANT_MESSAGE,
      stopReason: "error",
      errorMessage: "Something went wrong",
    });
    isContextOverflowMock.mockReturnValueOnce(false);

    const res = await post("/v1/chat/completions", VALID_BODY);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.type).toBe("server_error");
    expect(json.error.code).toBe("server_error");
    expect(json.error.message).toBe("Something went wrong");
  });
});
