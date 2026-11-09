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

vi.mock("../src/lib/pi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi")>();
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
    validateAllModels: vi
      .fn()
      .mockResolvedValue({ validatedAt: "2026-01-01T00:00:00.000Z", models: {} }),
  };
});

vi.mock("../src/services/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/registry")>();
  return {
    ...actual,
    resolveModel: vi.fn(actual.resolveModel),
    lookupModel: vi.fn(actual.lookupModel),
    // Spy that calls through to the real impl, so existing tests that call loadRegistry()
    // to populate the registry still work, while the validate-route tests can assert it fired.
    loadRegistry: vi.fn(actual.loadRegistry),
  };
});

// Spy on log.info to capture middleware emissions without mocking the whole module
// (which would break the rest of the app's logging path). `log` is a pino instance whose
// methods live on the prototype, so we layer over it with Object.create — that keeps
// warn/error/debug reachable while overriding only info. (A plain `{ ...actual.log }`
// spread would drop the prototype methods and make log.warn undefined.)
const logInfoMock = vi.fn();
vi.mock("../src/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/logger")>();
  return {
    ...actual,
    log: Object.assign(Object.create(actual.log), { info: logInfoMock }),
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

const OLLAMA_TEST_MODEL = {
  id: "qwen3:30b",
  model: {
    id: "qwen3:30b",
    name: "qwen3:30b",
    api: "openai-completions" as const,
    provider: "ollama",
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 4096,
  },
  provider: "ollama" as const,
  capability: "chat" as const,
};

describe("Health check", () => {
  it("GET / returns status ok", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.name).toBe("llm-gateway");
    const { APP_VERSION } = await import("../src/config");
    expect(json.version).toBe(APP_VERSION);
    expect(json).toHaveProperty("commit"); // the image's commit; null outside CI builds
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
    // The route looks the model up; make it find a valid one for this test
    const { lookupModel } = await import("../src/services/registry");
    vi.mocked(lookupModel).mockReturnValueOnce({
      kind: "found",
      resolved: {
        id: "test",
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
      },
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

  // docs/model-ids.md: a bare ID two providers list is named, never silently picked.
  it("returns 400 ambiguous_model for an ID two providers list, on chat and embeddings", async () => {
    const { lookupModel } = await import("../src/services/registry");
    const choices = ["ollama/deepseek-flash", "deepseek/deepseek-flash"];
    for (const path of ["/v1/chat/completions", "/v1/embeddings"]) {
      vi.mocked(lookupModel).mockReturnValueOnce({ kind: "ambiguous", choices });
      const body = path.endsWith("embeddings")
        ? { model: "deepseek-flash", input: "hi" }
        : { ...VALID_BODY, model: "deepseek-flash" };
      const res = await post(path, body);
      expect(res.status, path).toBe(400);
      const json = await res.json();
      expect(json.error).toMatchObject({ code: "ambiguous_model", param: "model" });
      expect(json.error.message).toContain("deepseek/deepseek-flash");
    }
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

describe("GET /v1/limits", () => {
  it("lists every family without a model", async () => {
    const res = await app.request("/v1/limits");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
  });

  it("returns 404 model_not_found for an unknown model", async () => {
    const res = await app.request("/v1/limits?model=nonexistent-model");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("model_not_found");
  });

  it("returns 400 ambiguous_model for a bare ID two providers list", async () => {
    const { lookupModel } = await import("../src/services/registry");
    vi.mocked(lookupModel).mockReturnValueOnce({
      kind: "ambiguous",
      choices: ["ollama/deepseek-flash", "deepseek/deepseek-flash"],
    });
    const res = await app.request("/v1/limits?model=deepseek-flash");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ambiguous_model");
  });

  it("calls a local model unlimited", async () => {
    const { lookupModel } = await import("../src/services/registry");
    vi.mocked(lookupModel).mockReturnValueOnce({
      kind: "found",
      resolved: {
        id: "qwen3:30b",
        model: { id: "qwen3:30b", provider: "ollama" } as never,
        provider: "ollama",
        capability: "chat",
      },
    });
    const res = await app.request("/v1/limits?model=qwen3:30b");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      model: "qwen3:30b",
      provider: "ollama",
      status: "ok",
      available: { kind: "unlimited" },
    });
  });

  it("calls a model that failed its last check unavailable, as /v1/models does", async () => {
    const { lookupModel } = await import("../src/services/registry");
    const { readValidationReport } = await import("../src/services/validation");
    vi.mocked(lookupModel).mockReturnValueOnce({ kind: "found", resolved: OLLAMA_TEST_MODEL });
    vi.mocked(readValidationReport).mockResolvedValueOnce({
      validatedAt: "2026-11-02T00:00:00.000Z",
      models: { "qwen3:30b": { status: "error", error: "Ollama error: model failed to load" } },
    });
    const res = await app.request("/v1/limits?model=qwen3:30b");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "unavailable",
      available: { kind: "unavailable", reason: "Ollama error: model failed to load" },
    });
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
    // What the model reads itself, so apps know which take images.
    expect(model.input).toEqual(["text"]);
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

  it("populates embedding_dimensions for embedding models from validation report", async () => {
    const { loadRegistry } = await import("../src/services/registry");
    const { fetchOllamaModels } = await import("../src/lib/ollama");
    const { readValidationReport } = await import("../src/services/validation");

    vi.mocked(fetchOllamaModels).mockResolvedValueOnce([
      {
        model: {
          id: "bge-m3:latest",
          name: "bge-m3:latest",
          api: "openai-completions",
          provider: "ollama",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
        capabilities: { supportsVision: false, supportsEmbedding: true, supportsCompletion: false },
      },
      {
        model: {
          id: "qwen3:30b",
          name: "qwen3:30b",
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
      validatedAt: "2026-05-07T00:00:00.000Z",
      models: {
        "bge-m3:latest": { status: "ok", latencyMs: 50, embeddingDim: 1024 },
        "qwen3:30b": { status: "ok", latencyMs: 200 },
      },
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = await res.json();

    const embedder = json.data.find((m: { id: string }) => m.id === "bge-m3:latest");
    expect(embedder.capability).toBe("embedding");
    expect(embedder.embedding_dimensions).toBe(1024);

    const chat = json.data.find((m: { id: string }) => m.id === "qwen3:30b");
    expect(chat.capability).toBe("chat");
    expect(chat.embedding_dimensions).toBeUndefined();
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
    const { lookupModel } = await import("../src/services/registry");
    vi.mocked(lookupModel).mockReturnValueOnce({ kind: "found", resolved: MOCK_MODEL });
  }

  it("returns 400 for context overflow errors", async () => {
    await mockResolveModel();
    const { complete } = await import("../src/lib/pi");
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
    const { complete } = await import("../src/lib/pi");
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
    const { complete } = await import("../src/lib/pi");
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

describe("Request access log middleware", () => {
  it("runs each request inside its req_id, so a stream's usage line carries it", async () => {
    const { requestContext } = await import("../src/lib/logger");
    const { lookupModel } = await import("../src/services/registry");
    vi.mocked(lookupModel).mockReturnValueOnce({
      kind: "found",
      resolved: { ...OLLAMA_TEST_MODEL, id: "test" },
    });
    const during: Record<string, string | undefined> = {};
    logInfoMock.mockReset();
    logInfoMock.mockImplementation((meta: { event?: string }) => {
      if (meta?.event) during[meta.event] = requestContext.getStore()?.req_id;
    });
    try {
      const res = await post("/v1/chat/completions", { ...VALID_BODY, stream: true });
      await res.text(); // the usage line is written when the stream finishes
      const access = findHttpRequestLog("/v1/chat/completions");
      expect(access?.req_id).toEqual(expect.any(String));
      expect(during["completion.usage"]).toBe(access?.req_id);
      expect(requestContext.getStore()).toBeUndefined();
    } finally {
      logInfoMock.mockReset();
    }
  });

  function findHttpRequestLog(path: string): Record<string, unknown> | undefined {
    for (const call of logInfoMock.mock.calls) {
      const [meta] = call as [Record<string, unknown> | undefined];
      if (meta?.event === "http.request" && meta?.path === path) {
        return meta;
      }
    }
    return undefined;
  }

  it("emits a single http.request log line per request with correct shape", async () => {
    logInfoMock.mockClear();
    const res = await post("/v1/chat/completions", VALID_BODY);
    expect(res.status).toBe(404); // unresolved model — we only care about the log line shape

    const logEntry = findHttpRequestLog("/v1/chat/completions");
    if (!logEntry) throw new Error("no http.request log line for /v1/chat/completions");
    expect(logEntry.method).toBe("POST");
    expect(logEntry.status).toBe(404);
    expect(logEntry.req_id).toEqual(expect.any(String));
    expect((logEntry.req_id as string).length).toBeGreaterThan(8);
    expect(logEntry.latency_ms).toEqual(expect.any(Number));
    expect((logEntry.latency_ms as number) >= 0).toBe(true);
  });

  it("logs failed-validation requests with status 400", async () => {
    logInfoMock.mockClear();
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }), // missing model
    });

    const logEntry = findHttpRequestLog("/v1/chat/completions");
    expect(logEntry).toBeDefined();
    expect(logEntry?.status).toBe(400);
  });

  it("does not log /openapi.json, /docs, or / (skip list)", async () => {
    logInfoMock.mockClear();
    await app.request("/openapi.json");
    await app.request("/");

    expect(findHttpRequestLog("/openapi.json")).toBeUndefined();
    expect(findHttpRequestLog("/")).toBeUndefined();
  });

  it("each request gets a unique req_id", async () => {
    logInfoMock.mockClear();
    await post("/v1/chat/completions", VALID_BODY);
    await post("/v1/chat/completions", VALID_BODY);

    const httpCalls = logInfoMock.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>)?.event === "http.request",
    );
    const ids = httpCalls.map((c) => (c[0] as Record<string, unknown>).req_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  function postWithId(id: string) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": id },
      body: JSON.stringify(VALID_BODY),
    });
  }

  it("returns its req_id in the X-Request-Id header", async () => {
    logInfoMock.mockClear();
    const res = await post("/v1/chat/completions", VALID_BODY);
    expect(res.headers.get("x-request-id")).toBe(
      findHttpRequestLog("/v1/chat/completions")?.req_id,
    );
  });

  it("logs the caller's X-Request-Id as request_id, on every line of the request", async () => {
    const { requestContext } = await import("../src/lib/logger");
    const { lookupModel } = await import("../src/services/registry");
    vi.mocked(lookupModel).mockReturnValueOnce({
      kind: "found",
      resolved: { ...OLLAMA_TEST_MODEL, id: "test" },
    });
    let duringUsage: string | undefined;
    logInfoMock.mockReset();
    logInfoMock.mockImplementation((meta: { event?: string }) => {
      if (meta?.event === "completion.usage") duringUsage = requestContext.getStore()?.request_id;
    });
    try {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Request-Id": "homestorm-turn-1" },
        body: JSON.stringify({ ...VALID_BODY, stream: true }),
      });
      await res.text();
      const access = findHttpRequestLog("/v1/chat/completions");
      expect(access?.request_id).toBe("homestorm-turn-1");
      expect(res.headers.get("x-request-id")).toBe(access?.req_id); // its own ID, not the caller's
      expect(duringUsage).toBe("homestorm-turn-1");
    } finally {
      logInfoMock.mockReset();
    }
  });

  it("drops a caller's X-Request-Id that doesn't look like an ID", async () => {
    for (const id of ["two words", "x".repeat(65), "a/b", '"quoted"']) {
      logInfoMock.mockClear();
      await postWithId(id);
      expect(findHttpRequestLog("/v1/chat/completions")).not.toHaveProperty("request_id");
    }
  });
});

describe("POST /v1/models/validate", () => {
  it("reloads the registry before validating so new models are picked up", async () => {
    const { loadRegistry } = await import("../src/services/registry");
    const { validateAllModels } = await import("../src/services/validation");
    vi.mocked(loadRegistry).mockClear();
    vi.mocked(validateAllModels).mockClear();

    const res = await app.request("/v1/models/validate", { method: "POST" });
    expect(res.status).toBe(200);

    expect(loadRegistry).toHaveBeenCalledTimes(1);
    expect(validateAllModels).toHaveBeenCalledTimes(1);
    // Reload must happen before validation, not after.
    expect(vi.mocked(loadRegistry).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(validateAllModels).mock.invocationCallOrder[0],
    );
  });

  it("still validates the current registry if the reload fails (non-fatal)", async () => {
    const { loadRegistry } = await import("../src/services/registry");
    const { validateAllModels } = await import("../src/services/validation");
    vi.mocked(loadRegistry).mockClear();
    vi.mocked(loadRegistry).mockRejectedValueOnce(new Error("ollama unreachable"));
    vi.mocked(validateAllModels).mockClear();

    const res = await app.request("/v1/models/validate", { method: "POST" });
    expect(res.status).toBe(200);
    // Reload failure is swallowed; validation of the already-loaded set still runs.
    expect(validateAllModels).toHaveBeenCalledTimes(1);
  });
});

describe("who the gateway answers to", () => {
  const OK_HOST = "llmgw.llmgw.svc.cluster.local";
  const fetchWith = (path: string, headers: Record<string, string>) =>
    app.request(path, { headers });

  it.each([
    OK_HOST,
    `${OK_HOST}:80`,
    "LLMGW.llmgw.SVC.cluster.local",
    "localhost",
    "localhost:51277",
    "127.0.0.1:51277",
  ])("answers to %s", async (host) => {
    expect((await fetchWith("/v1/models", { host })).status).toBe(200);
  });

  it.each([
    "evil.example",
    "llmgw.llmgw",
    "llmgw.llmgw.svc",
    `${OK_HOST}.`,
    `${OK_HOST}.evil.example`,
    "10.43.151.52",
    "192.168.1.163",
    "not a host",
  ])("refuses the host %s", async (host) => {
    const res = await fetchWith("/v1/models", { host });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("host_not_allowed");
  });

  it("guards every route that does anything", async () => {
    for (const path of ["/v1/models", "/v1/limits", "/docs", "/openapi.json"]) {
      expect((await fetchWith(path, { host: "evil.example" })).status, path).toBe(403);
    }
    const chat = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { host: "evil.example", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(403);
  });

  it("answers a Kubernetes probe, which sends the pod's IP as its host", async () => {
    const res = await fetchWith("/", { host: "10.42.0.37:51277" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("refuses a web page from anywhere else, with no CORS headers", async () => {
    const res = await fetchWith("/v1/models", { host: OK_HOST, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("origin_not_allowed");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a browser's preflight from anywhere else", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        host: OK_HOST,
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each(["null", "not a url", `http://${OK_HOST}:8080`, `http://${OK_HOST}.evil.example`])(
    "refuses the origin %s",
    async (origin) => {
      expect((await fetchWith("/v1/models", { host: OK_HOST, origin })).status).toBe(403);
    },
  );

  it("lets the Swagger UI call the gateway from its own address", async () => {
    const res = await fetchWith("/v1/models", { host: OK_HOST, origin: `http://${OK_HOST}` });
    expect(res.status).toBe(200);
  });

  it("serves /docs on the gateway's own name, listing that name as the server", async () => {
    expect((await fetchWith("/docs", { host: OK_HOST })).status).toBe(200);
    const spec = await (await fetchWith("/openapi.json", { host: OK_HOST })).json();
    expect(spec.servers[0].url).toBe(`http://${OK_HOST}`);
  });

  it("doesn't need a browser's headers: an app sends only its host", async () => {
    const res = await fetchWith("/v1/models", { host: OK_HOST });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
