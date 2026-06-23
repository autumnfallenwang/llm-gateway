import type { Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "../src/errors";
import { createEmbedding } from "../src/services/embeddings";
import type { ResolvedModel } from "../src/services/registry";

// ── Test fixtures ───────────────────────────────────────────────────────────

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
  provider: ResolvedModel["provider"];
  capability: ResolvedModel["capability"];
  id?: string;
}): ResolvedModel {
  return {
    model: makeOllamaModel(opts.id ?? "bge-m3:latest"),
    provider: opts.provider,
    capability: opts.capability,
  };
}

function ollamaResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const HAPPY_RESPONSE = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: "bge-m3:latest",
  usage: { prompt_tokens: 5, total_tokens: 5 },
};

// ── Fetch mock ──────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Provider gate ───────────────────────────────────────────────────────────

describe("createEmbedding: provider gate", () => {
  it("rejects anthropic with 501 provider_unsupported", async () => {
    const resolved = makeResolved({ provider: "anthropic", capability: "chat" });

    await expect(createEmbedding(resolved, { model: "x", input: "hi" })).rejects.toMatchObject({
      httpStatus: 501,
      errorType: "invalid_request_error",
      errorCode: "provider_unsupported",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects codex with 501 provider_unsupported", async () => {
    const resolved = makeResolved({ provider: "codex", capability: "chat" });

    await expect(createEmbedding(resolved, { model: "x", input: "hi" })).rejects.toBeInstanceOf(
      BackendError,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("error message names the canonical provider label", async () => {
    const resolved = makeResolved({ provider: "codex", capability: "chat" });

    await expect(createEmbedding(resolved, { model: "x", input: "hi" })).rejects.toThrow(
      /openai-codex/,
    );
  });
});

// ── Capability gate ─────────────────────────────────────────────────────────

describe("createEmbedding: capability gate", () => {
  it("rejects chat-capability Ollama model with 400 wrong_capability", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "chat" });

    await expect(createEmbedding(resolved, { model: "x", input: "hi" })).rejects.toMatchObject({
      httpStatus: 400,
      errorType: "invalid_request_error",
      errorCode: "wrong_capability",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("error message points users to /v1/chat/completions", async () => {
    const resolved = makeResolved({
      provider: "ollama",
      capability: "chat",
      id: "qwen3:30b",
    });

    await expect(createEmbedding(resolved, { model: "qwen3:30b", input: "hi" })).rejects.toThrow(
      /POST \/v1\/chat\/completions/,
    );
  });
});

// ── Happy path passthrough ──────────────────────────────────────────────────

describe("createEmbedding: Ollama passthrough", () => {
  it("forwards single-string input verbatim and returns response verbatim", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(ollamaResponse(HAPPY_RESPONSE));

    const result = await createEmbedding(resolved, {
      model: "bge-m3:latest",
      input: "hello world",
    });

    expect(result).toEqual(HAPPY_RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/embeddings$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "bge-m3:latest",
      input: "hello world",
    });
  });

  it("forwards array (batch) input verbatim", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    const batchResponse = {
      object: "list",
      data: [
        { object: "embedding", index: 0, embedding: [0.1] },
        { object: "embedding", index: 1, embedding: [0.2] },
        { object: "embedding", index: 2, embedding: [0.3] },
      ],
      model: "bge-m3:latest",
      usage: { prompt_tokens: 10, total_tokens: 10 },
    };
    fetchMock.mockResolvedValueOnce(ollamaResponse(batchResponse));

    const result = await createEmbedding(resolved, {
      model: "bge-m3:latest",
      input: ["alpha", "beta", "gamma"],
    });

    expect(result.data).toHaveLength(3);
    expect(result.data.map((d) => d.index)).toEqual([0, 1, 2]);

    const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sentBody.input).toEqual(["alpha", "beta", "gamma"]);
  });

  it("forwards encoding_format='base64' through to Ollama", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      ollamaResponse({
        ...HAPPY_RESPONSE,
        data: [{ object: "embedding", index: 0, embedding: "AAAAAA==" }],
      }),
    );

    const result = await createEmbedding(resolved, {
      model: "bge-m3:latest",
      input: "x",
      encoding_format: "base64",
    });

    expect(typeof result.data[0].embedding).toBe("string");

    const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sentBody.encoding_format).toBe("base64");
  });

  it("forwards dimensions param through to Ollama", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      ollamaResponse({
        ...HAPPY_RESPONSE,
        data: [{ object: "embedding", index: 0, embedding: new Array(512).fill(0) }],
      }),
    );

    const result = await createEmbedding(resolved, {
      model: "bge-m3:latest",
      input: "x",
      dimensions: 512,
    });

    if (Array.isArray(result.data[0].embedding)) {
      expect(result.data[0].embedding).toHaveLength(512);
    }

    const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sentBody.dimensions).toBe(512);
  });

  it("forwards an AbortSignal to fetch when supplied via options", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(ollamaResponse(HAPPY_RESPONSE));

    const controller = new AbortController();
    await createEmbedding(
      resolved,
      { model: "bge-m3:latest", input: "x" },
      { signal: controller.signal },
    );

    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBe(controller.signal);
  });

  it("does not mutate the request body before forwarding", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(ollamaResponse(HAPPY_RESPONSE));

    const requestBody = {
      model: "bge-m3:latest",
      input: "preserve me",
      user: "user-42",
    };

    await createEmbedding(resolved, requestBody);

    const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sentBody).toEqual(requestBody);
  });
});

// ── Upstream error mapping ──────────────────────────────────────────────────

describe("createEmbedding: upstream error mapping", () => {
  it("maps Ollama 404 to BackendError(404, model_not_found)", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      ollamaResponse(
        {
          error: {
            message: 'model "ghost" not found, try pulling it first',
            type: "not_found_error",
            param: null,
            code: null,
          },
        },
        404,
      ),
    );

    await expect(createEmbedding(resolved, { model: "ghost", input: "x" })).rejects.toMatchObject({
      httpStatus: 404,
      errorType: "invalid_request_error",
      errorCode: "model_not_found",
    });
  });

  it("maps Ollama 400 to BackendError(400, invalid_input)", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      ollamaResponse(
        {
          error: { message: "invalid input", type: "invalid_request_error" },
        },
        400,
      ),
    );

    await expect(
      createEmbedding(resolved, { model: "bge-m3:latest", input: [] as never }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      errorCode: "invalid_input",
    });
  });

  it("maps Ollama 429 to BackendError(429, rate_limit_exceeded)", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      ollamaResponse({ error: { message: "too many requests" } }, 429),
    );

    await expect(
      createEmbedding(resolved, { model: "bge-m3:latest", input: "x" }),
    ).rejects.toMatchObject({
      httpStatus: 429,
      errorCode: "rate_limit_exceeded",
    });
  });

  it("maps Ollama 5xx to BackendError(500, server_error)", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      ollamaResponse({ error: { message: "internal server error" } }, 503),
    );

    await expect(
      createEmbedding(resolved, { model: "bge-m3:latest", input: "x" }),
    ).rejects.toMatchObject({
      httpStatus: 500,
      errorCode: "server_error",
    });
  });

  it("handles non-JSON upstream error body without crashing", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockResolvedValueOnce(
      new Response("plain text error", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(
      createEmbedding(resolved, { model: "bge-m3:latest", input: "x" }),
    ).rejects.toMatchObject({
      httpStatus: 500,
      errorCode: "server_error",
    });
  });

  it("maps fetch network failure to BackendError(500, server_error)", async () => {
    const resolved = makeResolved({ provider: "ollama", capability: "embedding" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createEmbedding(resolved, { model: "bge-m3:latest", input: "x" }),
    ).rejects.toMatchObject({
      httpStatus: 500,
      errorCode: "server_error",
      message: expect.stringContaining("fetch failed"),
    });
  });
});
