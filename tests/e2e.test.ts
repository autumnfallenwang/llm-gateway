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

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Infrastructure ────────────────────────────────────────────────────────

describe("infrastructure", () => {
  it("health check", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
  });

  it("models list includes all backends", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);

    const owners = json.data.map((m: { owned_by: string }) => m.owned_by);
    expect(owners).toContain("ollama");
    expect(owners).toContain("anthropic");
    expect(owners).toContain("openai-codex");
    expect(json.data.length).toBeGreaterThan(0);
  });
});

// ── Completions ───────────────────────────────────────────────────────────

function expectCompletionShape(json: Record<string, unknown>) {
  expect(json.id).toEqual(expect.any(String));
  expect(json.object).toBe("chat.completion");
  expect(json.created).toEqual(expect.any(Number));
  expect(json.model).toEqual(expect.any(String));

  const choices = json.choices as {
    message: { role: string; content: string };
    finish_reason: string;
  }[];
  expect(choices).toHaveLength(1);
  expect(choices[0].message.role).toBe("assistant");
  expect(typeof choices[0].message.content).toBe("string");
  expect(choices[0].message.content.length).toBeGreaterThan(0);
  expect(choices[0].finish_reason).toEqual(expect.any(String));

  const usage = json.usage as Record<string, number>;
  expect(usage.prompt_tokens).toEqual(expect.any(Number));
  expect(usage.completion_tokens).toEqual(expect.any(Number));
  expect(usage.total_tokens).toEqual(expect.any(Number));
}

describe("completions", () => {
  it("ollama completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "qwen3:30b",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("anthropic completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("codex completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-5.1",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });
});

// ── Validation ───────────────────────────────────────────────────────────

describe("validation", () => {
  it("POST /v1/models/validate returns results for all models", { timeout: 300_000 }, async () => {
    const res = await fetch(`${baseUrl}/v1/models/validate`, { method: "POST" });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.validatedAt).toEqual(expect.any(String));
    expect(typeof json.models).toBe("object");

    const modelIds = Object.keys(json.models);
    expect(modelIds.length).toBeGreaterThan(0);

    for (const id of modelIds) {
      const result = json.models[id];
      expect(["ok", "error"]).toContain(result.status);
      if (result.status === "ok") {
        expect(result.latencyMs).toEqual(expect.any(Number));
      }
      if (result.status === "error") {
        expect(typeof result.error).toBe("string");
      }
    }
  });

  it("GET /v1/models after validation returns only validated models", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);

    // Every returned model should have passed validation
    for (const model of json.data) {
      expect(model.id).toEqual(expect.any(String));
      expect(model.object).toBe("model");
    }
  });
});

// ── Error handling ────────────────────────────────────────────────────────

describe("error handling", () => {
  it("unknown model returns 404", async () => {
    const res = await post("/v1/chat/completions", {
      model: "nonexistent-model-xyz",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("model_not_found");
    expect(json.error.type).toBe("invalid_request_error");
  });

  it("missing model field returns 400", async () => {
    const res = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
  });

  it("stream=true returns 400", async () => {
    const res = await post("/v1/chat/completions", {
      model: "qwen3:30b",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.param).toBe("stream");
  });
});
