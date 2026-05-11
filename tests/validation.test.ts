import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDb, openDb, setDb } from "../src/lib/db";
import type { ResolvedModel } from "../src/services/registry";

const completeMock = vi.fn();
const listModelsMock = vi.fn();
const resolveModelMock = vi.fn();
const ensureAnthropicFreshMock = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...actual, complete: completeMock };
});

vi.mock("../src/services/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/registry")>();
  return {
    ...actual,
    listModels: listModelsMock,
    resolveModel: resolveModelMock,
  };
});

vi.mock("../src/services/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/auth")>();
  return { ...actual, ensureAnthropicFresh: ensureAnthropicFreshMock };
});

// Import after mocks are set up
const { validateSingleModel, validateAllModels, readValidationReport } = await import(
  "../src/services/validation"
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeOllamaModel(id: string): Model<string> {
  return {
    id,
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    name: id,
    contextWindow: 8192,
    maxTokens: 4096,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cutoff: "",
    reasoning: false,
  } as unknown as Model<string>;
}

function makeResolved(opts: {
  capability: ResolvedModel["capability"];
  provider?: ResolvedModel["provider"];
  id?: string;
}): ResolvedModel {
  return {
    model: makeOllamaModel(opts.id ?? "bge-m3:latest"),
    provider: opts.provider ?? "ollama",
    capability: opts.capability,
  };
}

function chatResponse(text: string, stopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "ollama",
    model: "test",
    content: [{ type: "text", text }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  };
}

function embeddingResponse(dim: number, indices = [0]): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: indices.map((i) => ({
        object: "embedding",
        index: i,
        embedding: new Array(dim).fill(0.01),
      })),
      model: "bge-m3:latest",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  completeMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Chat path ───────────────────────────────────────────────────────────────

describe("validateSingleModel: chat capability", () => {
  it("returns ok when model returns a non-empty response with stop reason 'stop'", async () => {
    const resolved = makeResolved({ capability: "chat", id: "qwen3:30b" });
    completeMock.mockResolvedValueOnce(chatResponse("hello"));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBeTypeOf("number");
    expect(result.error).toBeUndefined();
    expect(result.embeddingDim).toBeUndefined();
  });

  it("returns ok with stop reason 'length'", async () => {
    const resolved = makeResolved({ capability: "chat", id: "qwen3:30b" });
    completeMock.mockResolvedValueOnce(chatResponse("trunc", "length"));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("ok");
  });

  it("returns error when stopReason is 'error'", async () => {
    const resolved = makeResolved({ capability: "chat" });
    completeMock.mockResolvedValueOnce(chatResponse("", "error"));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/unexpected stopReason: error/);
  });

  it("returns error on empty response text", async () => {
    const resolved = makeResolved({ capability: "chat" });
    completeMock.mockResolvedValueOnce(chatResponse("   "));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("error");
    expect(result.error).toBe("empty response");
  });

  it("returns error when complete() throws", async () => {
    const resolved = makeResolved({ capability: "chat" });
    completeMock.mockRejectedValueOnce(new Error("network refused"));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("error");
    expect(result.error).toBe("network refused");
  });

  it("does not call fetch (chat path uses pi-ai, not /v1/embeddings)", async () => {
    const resolved = makeResolved({ capability: "chat" });
    completeMock.mockResolvedValueOnce(chatResponse("ok"));

    await validateSingleModel(resolved, 60_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Embedding path ──────────────────────────────────────────────────────────

describe("validateSingleModel: embedding capability", () => {
  it("returns ok and records embeddingDim from upstream response", async () => {
    const resolved = makeResolved({ capability: "embedding", id: "bge-m3:latest" });
    fetchMock.mockResolvedValueOnce(embeddingResponse(1024));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("ok");
    expect(result.embeddingDim).toBe(1024);
    expect(result.latencyMs).toBeTypeOf("number");
    expect(result.error).toBeUndefined();
  });

  it("records different dim per model (768 for nomic-embed-text)", async () => {
    const resolved = makeResolved({ capability: "embedding", id: "nomic-embed-text:latest" });
    fetchMock.mockResolvedValueOnce(embeddingResponse(768));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("ok");
    expect(result.embeddingDim).toBe(768);
  });

  it("calls /v1/embeddings, not chat completions", async () => {
    const resolved = makeResolved({ capability: "embedding" });
    fetchMock.mockResolvedValueOnce(embeddingResponse(1024));

    await validateSingleModel(resolved, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/embeddings$/);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("sends a fixed test input ('test')", async () => {
    const resolved = makeResolved({ capability: "embedding" });
    fetchMock.mockResolvedValueOnce(embeddingResponse(1024));

    await validateSingleModel(resolved, 60_000);

    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(String(init?.body));
    expect(body.input).toBe("test");
  });

  it("returns error when data array is empty", async () => {
    const resolved = makeResolved({ capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [],
          model: "x",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
        { status: 200 },
      ),
    );

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("error");
    expect(result.error).toBe("empty embedding vector");
    expect(result.embeddingDim).toBeUndefined();
  });

  it("returns error when first vector is zero-length", async () => {
    const resolved = makeResolved({ capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [] }],
          model: "x",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
        { status: 200 },
      ),
    );

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("error");
    expect(result.error).toBe("empty embedding vector");
  });

  it("returns error when upstream returns 404", async () => {
    const resolved = makeResolved({ capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }),
    );

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/model not found/);
  });

  it("returns error on fetch network failure", async () => {
    const resolved = makeResolved({ capability: "embedding" });
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));

    const result = await validateSingleModel(resolved, 60_000);

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/connection refused/);
  });
});

// ── validateAllModels / readValidationReport (DB-backed) ───────────────────

describe("validateAllModels: DB persistence", () => {
  let db: AppDb;

  beforeEach(() => {
    db = openDb(":memory:");
    setDb(db);
    listModelsMock.mockReset();
    resolveModelMock.mockReset();
    ensureAnthropicFreshMock.mockReset();
    ensureAnthropicFreshMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
  });

  it("writes the report to the DB and a follow-up read returns the same payload", async () => {
    const chatResolved = makeResolved({ capability: "chat", id: "qwen3:30b" });
    const embedResolved = makeResolved({ capability: "embedding", id: "bge-m3:latest" });

    listModelsMock.mockReturnValue([{ id: "qwen3:30b" }, { id: "bge-m3:latest" }]);
    resolveModelMock.mockImplementation((id: string) => {
      if (id === "qwen3:30b") return chatResolved;
      if (id === "bge-m3:latest") return embedResolved;
      return undefined;
    });
    completeMock.mockResolvedValue(chatResponse("hello"));
    fetchMock.mockResolvedValue(embeddingResponse(1024));

    const report = await validateAllModels();

    expect(report.validatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.models["qwen3:30b"].status).toBe("ok");
    expect(report.models["bge-m3:latest"].status).toBe("ok");
    expect(report.models["bge-m3:latest"].embeddingDim).toBe(1024);

    // Stored row matches and survives across the read seam
    const stored = await readValidationReport();
    expect(stored).toEqual(report);
  });

  it("readValidationReport returns null on an unwritten DB", async () => {
    expect(await readValidationReport()).toBeNull();
  });

  it("records unresolvable models as error rows", async () => {
    listModelsMock.mockReturnValue([{ id: "ghost-model" }]);
    resolveModelMock.mockReturnValue(undefined);

    const report = await validateAllModels();

    expect(report.models["ghost-model"]).toEqual({
      status: "error",
      error: "model not resolvable",
    });
    const stored = await readValidationReport();
    expect(stored?.models["ghost-model"].status).toBe("error");
  });

  it("refreshes the Anthropic OAuth chain once before validating", async () => {
    listModelsMock.mockReturnValue([{ id: "qwen3:30b" }]);
    resolveModelMock.mockReturnValue(makeResolved({ capability: "chat", id: "qwen3:30b" }));
    completeMock.mockResolvedValue(chatResponse("ok"));

    await validateAllModels();

    expect(ensureAnthropicFreshMock).toHaveBeenCalledTimes(1);
  });

  it("continues when the Anthropic refresh fails (Anthropic rows report error, others still tested)", async () => {
    ensureAnthropicFreshMock.mockRejectedValueOnce(new Error("upstream 500"));
    listModelsMock.mockReturnValue([{ id: "qwen3:30b" }]);
    resolveModelMock.mockReturnValue(makeResolved({ capability: "chat", id: "qwen3:30b" }));
    completeMock.mockResolvedValue(chatResponse("ok"));

    const report = await validateAllModels();

    // Refresh threw, but the validation still produced a complete report.
    expect(ensureAnthropicFreshMock).toHaveBeenCalledTimes(1);
    expect(report.models["qwen3:30b"].status).toBe("ok");
  });
});
