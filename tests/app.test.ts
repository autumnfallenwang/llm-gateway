import { describe, expect, it, vi } from "vitest";

const MOCK_ASSISTANT_MESSAGE = {
  role: "assistant",
  content: [{ type: "text", text: "Mock response" }],
  api: "openai-completions",
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
  stopReason: "stop",
  timestamp: 1700000000000,
};

function createMockEventStream() {
  const events = [
    { type: "text_delta", contentIndex: 0, delta: "Mock ", partial: MOCK_ASSISTANT_MESSAGE },
    { type: "text_delta", contentIndex: 0, delta: "response", partial: MOCK_ASSISTANT_MESSAGE },
    { type: "done", reason: "stop", message: MOCK_ASSISTANT_MESSAGE },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    result: () => Promise.resolve(MOCK_ASSISTANT_MESSAGE),
  };
}

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: vi.fn().mockResolvedValue(MOCK_ASSISTANT_MESSAGE),
    stream: vi.fn().mockImplementation(() => createMockEventStream()),
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
});

describe("GET /v1/models", () => {
  it("returns models list shape", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
  });
});
