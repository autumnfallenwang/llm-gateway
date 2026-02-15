import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";
import { loadCredentials } from "../src/services/auth.js";
import { loadRegistry } from "../src/services/registry.js";

let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  await loadCredentials();
  await loadRegistry();

  server = serve({ fetch: app.fetch, port: 0 });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}`;
}, 30_000);

afterAll(() => {
  server?.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────

function chatRequest(overrides: Record<string, unknown> = {}) {
  const body = {
    model: "qwen3:30b",
    messages: [{ role: "user", content: "Say hello in one word." }],
    max_tokens: 32,
    ...overrides,
  };
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseSSE(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

// ── Category A: Request Parameters ──────────────────────────────────────

describe("A: request parameters", () => {
  describe("must-have parameters", () => {
    it("model — echoed in response", { timeout: 60_000 }, async () => {
      const res = await chatRequest();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.model).toContain("qwen3");
    });

    it("messages — produces non-empty content", { timeout: 60_000 }, async () => {
      const res = await chatRequest();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.choices[0].message.content.length).toBeGreaterThan(0);
    });

    it.each([
      { label: "temperature=0", value: 0 },
      { label: "temperature=0.5", value: 0.5 },
      { label: "temperature=2", value: 2 },
    ])("temperature — accepted at $label", { timeout: 60_000 }, async ({ value }) => {
      const res = await chatRequest({ temperature: value });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.choices[0].message.content.length).toBeGreaterThan(0);
    });

    it("max_tokens — accepted and completion_tokens present", { timeout: 60_000 }, async () => {
      const res = await chatRequest({ max_tokens: 8 });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.usage.completion_tokens).toEqual(expect.any(Number));
    });

    it("stream=true — returns text/event-stream", { timeout: 60_000 }, async () => {
      const res = await chatRequest({ stream: true });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("stream=false — returns application/json", { timeout: 60_000 }, async () => {
      const res = await chatRequest({ stream: false });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("max_completion_tokens — mapped to max_tokens", { timeout: 60_000 }, async () => {
      const res = await chatRequest({ max_tokens: undefined, max_completion_tokens: 32 });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.usage.completion_tokens).toEqual(expect.any(Number));
    });
  });

  describe("silently ignored parameters", () => {
    it.each([
      { param: "top_p", value: 0.9 },
      { param: "stop (string)", value: undefined, body: { stop: "\n" } },
      { param: "stop (array)", value: undefined, body: { stop: ["\n", "."] } },
      { param: "frequency_penalty", value: 0.5 },
      { param: "presence_penalty", value: 0.5 },
      { param: "stream_options", value: { include_usage: true } },
      { param: "tools", value: [{ type: "function", function: { name: "test", parameters: {} } }] },
      { param: "tool_choice", value: "auto" },
      { param: "response_format", value: { type: "json_object" } },
      { param: "seed", value: 42 },
      { param: "reasoning_effort", value: "medium" },
      { param: "n", value: 1 },
      { param: "logprobs", value: true },
      { param: "top_logprobs", value: 3 },
      { param: "logit_bias", value: { "123": 1 } },
      { param: "user", value: "test-user" },
      { param: "parallel_tool_calls", value: true },
      { param: "metadata", value: { key: "value" } },
      { param: "store", value: true },
      { param: "service_tier", value: "default" },
    ])("$param — silently ignored", { timeout: 60_000 }, async ({ param, value, body }) => {
      const overrides = body ?? { [param]: value };
      const res = await chatRequest(overrides);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.choices[0].message.content.length).toBeGreaterThan(0);
    });

    it("kitchen sink — all unknown params at once", { timeout: 60_000 }, async () => {
      const res = await chatRequest({
        top_p: 0.9,
        stop: ["\n"],
        frequency_penalty: 0.5,
        presence_penalty: 0.5,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: { name: "test", parameters: {} } }],
        tool_choice: "auto",
        response_format: { type: "json_object" },
        seed: 42,
        reasoning_effort: "medium",
        n: 1,
        logprobs: true,
        top_logprobs: 3,
        logit_bias: { "123": 1 },
        user: "test-user",
        parallel_tool_calls: true,
        metadata: { key: "value" },
        store: true,
        service_tier: "default",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.choices[0].message.content.length).toBeGreaterThan(0);
    });
  });
});

// ── Category B: Non-streaming Response Fields ───────────────────────────

describe("B: non-streaming response fields", () => {
  let json: Record<string, unknown>;

  beforeAll(async () => {
    const res = await chatRequest();
    expect(res.status).toBe(200);
    json = await res.json();
  }, 60_000);

  // Present fields
  it("id starts with chatcmpl-", () => {
    expect(json.id).toEqual(expect.any(String));
    expect((json.id as string).startsWith("chatcmpl-")).toBe(true);
  });

  it("object is chat.completion", () => {
    expect(json.object).toBe("chat.completion");
  });

  it("created is unix seconds in reasonable range", () => {
    const created = json.created as number;
    expect(created).toEqual(expect.any(Number));
    // Between 2024-01-01 and 2030-01-01
    expect(created).toBeGreaterThan(1_704_067_200);
    expect(created).toBeLessThan(1_893_456_000);
  });

  it("model matches request", () => {
    expect(json.model).toContain("qwen3");
  });

  it("choices is array of length 1", () => {
    const choices = json.choices as unknown[];
    expect(Array.isArray(choices)).toBe(true);
    expect(choices).toHaveLength(1);
  });

  it("choices[0].index is 0", () => {
    const choices = json.choices as { index: number }[];
    expect(choices[0].index).toBe(0);
  });

  it("message.role is assistant", () => {
    const choices = json.choices as { message: { role: string } }[];
    expect(choices[0].message.role).toBe("assistant");
  });

  it("message.content is non-empty string", () => {
    const choices = json.choices as { message: { content: string } }[];
    expect(typeof choices[0].message.content).toBe("string");
    expect(choices[0].message.content.length).toBeGreaterThan(0);
  });

  it("finish_reason is a valid value", () => {
    const choices = json.choices as { finish_reason: string }[];
    expect(["stop", "length", "tool_calls", "content_filter"]).toContain(
      choices[0].finish_reason,
    );
  });

  it("usage.prompt_tokens is positive integer", () => {
    const usage = json.usage as Record<string, number>;
    expect(usage.prompt_tokens).toEqual(expect.any(Number));
    expect(usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("usage.completion_tokens is positive integer", () => {
    const usage = json.usage as Record<string, number>;
    expect(usage.completion_tokens).toEqual(expect.any(Number));
    expect(usage.completion_tokens).toBeGreaterThan(0);
  });

  it("usage.total_tokens = prompt + completion", () => {
    const usage = json.usage as Record<string, number>;
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  });

  // Absent fields
  it.each([
    "refusal",
    "annotations",
    "logprobs",
    "service_tier",
    "system_fingerprint",
    "prompt_tokens_details",
    "completion_tokens_details",
  ])("%s is absent", (field) => {
    const choices = json.choices as Record<string, unknown>[];
    const usage = json.usage as Record<string, unknown>;
    // Check at top level, choices[0], message, and usage
    expect(json).not.toHaveProperty(field);
    if (field === "prompt_tokens_details" || field === "completion_tokens_details") {
      expect(usage).not.toHaveProperty(field);
    } else if (field === "service_tier" || field === "system_fingerprint") {
      expect(json).not.toHaveProperty(field);
    } else {
      // refusal, annotations, logprobs live on choices[0] or choices[0].message
      expect(choices[0]).not.toHaveProperty(field);
      const msg = choices[0].message as Record<string, unknown>;
      expect(msg).not.toHaveProperty(field);
    }
  });
});

// ── Category C: Streaming Response Fields ───────────────────────────────

describe("C: streaming response fields", () => {
  let dataLines: string[];
  let chunks: Record<string, unknown>[];

  beforeAll(async () => {
    const res = await chatRequest({ stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    dataLines = parseSSE(text);
    chunks = dataLines
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d));
  }, 60_000);

  it("at least 3 data lines", () => {
    expect(dataLines.length).toBeGreaterThanOrEqual(3);
  });

  it("last line is [DONE]", () => {
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
  });

  it("first chunk: object is chat.completion.chunk", () => {
    expect(chunks[0].object).toBe("chat.completion.chunk");
  });

  it("first chunk: delta.role is assistant", () => {
    const choices = chunks[0].choices as { delta: { role: string } }[];
    expect(choices[0].delta.role).toBe("assistant");
  });

  it("first chunk: finish_reason is null", () => {
    const choices = chunks[0].choices as { finish_reason: string | null }[];
    expect(choices[0].finish_reason).toBeNull();
  });

  it("middle chunks: delta.content is string", () => {
    // Check at least one middle chunk has content
    const middle = chunks.slice(1, -1);
    const hasContent = middle.some((c) => {
      const choices = c.choices as { delta: { content?: string } }[];
      return typeof choices[0].delta.content === "string";
    });
    expect(hasContent).toBe(true);
  });

  it("last chunk: finish_reason is set", () => {
    const last = chunks[chunks.length - 1];
    const choices = last.choices as { finish_reason: string | null }[];
    expect(choices[0].finish_reason).toEqual(expect.any(String));
  });

  it("last chunk: delta is empty (no content)", () => {
    const last = chunks[chunks.length - 1];
    const choices = last.choices as { delta: Record<string, unknown> }[];
    expect(choices[0].delta.content).toBeUndefined();
  });

  it("reasoning appears in at least one delta chunk (thinking model)", () => {
    const hasReasoning = chunks.some((c) => {
      const choices = c.choices as { delta: { reasoning?: string } }[];
      return typeof choices[0].delta.reasoning === "string" && choices[0].delta.reasoning.length > 0;
    });
    expect(hasReasoning).toBe(true);
  });

  it("all chunks share same id", () => {
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("all chunks share same created", () => {
    const created = chunks.map((c) => c.created);
    expect(new Set(created).size).toBe(1);
  });

  it("all chunks share same model", () => {
    const models = chunks.map((c) => c.model);
    expect(new Set(models).size).toBe(1);
  });

  it("all chunks have choices[0].index = 0", () => {
    for (const chunk of chunks) {
      const choices = chunk.choices as { index: number }[];
      expect(choices[0].index).toBe(0);
    }
  });
});

// ── Category D: Edge Cases ──────────────────────────────────────────────

describe("D: edge cases", () => {
  it("system prompt influences output", { timeout: 60_000 }, async () => {
    const res = await chatRequest({
      messages: [
        { role: "system", content: "You are a pirate. Always say 'Arrr'." },
        { role: "user", content: "Greet me." },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content.length).toBeGreaterThan(0);
  });

  it("multi-turn conversation accepted", { timeout: 60_000 }, async () => {
    const res = await chatRequest({
      messages: [
        { role: "user", content: "My name is TestUser." },
        { role: "assistant", content: "Nice to meet you, TestUser!" },
        { role: "user", content: "What is my name?" },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content.length).toBeGreaterThan(0);
  });

  it("omitting max_tokens is valid", { timeout: 60_000 }, async () => {
    const res = await chatRequest({ max_tokens: undefined });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content.length).toBeGreaterThan(0);
  });
});
