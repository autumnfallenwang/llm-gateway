import { type ServerType, serve } from "@hono/node-server";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app.js";
import { loadCredentials } from "../src/services/auth.js";
import { loadRegistry } from "../src/services/registry.js";

let dataUriJpeg: string;
// Google's public WebP demo gallery — small JPEG, real photograph, no UA filtering.
// (Wikimedia thumbnail URLs return HTTP 400 to non-browser User-Agents.)
const HTTPS_IMAGE_URL = "https://www.gstatic.com/webp/gallery/1.jpg";

let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  await loadCredentials();
  await loadRegistry();

  server = serve({ fetch: app.fetch, port: 0 });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}`;

  const redPixel = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
  dataUriJpeg = `data:image/jpeg;base64,${redPixel.toString("base64")}`;
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
    expect(owners).toContain("google-gemini-cli");
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

  it("gemini completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });
});

// ── Streaming ────────────────────────────────────────────────────────────

function parseSSE(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

function expectChunkShape(json: Record<string, unknown>) {
  expect(json.id).toEqual(expect.any(String));
  expect(json.object).toBe("chat.completion.chunk");
  expect(json.created).toEqual(expect.any(Number));
  expect(json.model).toEqual(expect.any(String));

  const choices = json.choices as {
    index: number;
    delta: Record<string, string>;
    finish_reason: string | null;
  }[];
  expect(choices).toHaveLength(1);
  expect(choices[0].index).toBe(0);
}

describe("streaming", () => {
  it("ollama streaming completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "qwen3:30b",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const dataLines = parseSSE(text);
    expect(dataLines.length).toBeGreaterThanOrEqual(3);

    // Last line is [DONE]
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    // First chunk has role
    const first = JSON.parse(dataLines[0]);
    expectChunkShape(first);
    expect(first.choices[0].delta.role).toBe("assistant");

    // Middle chunks have content or reasoning
    const middle = JSON.parse(dataLines[1]);
    expectChunkShape(middle);
    const delta = middle.choices[0].delta;
    expect(typeof delta.content === "string" || typeof delta.reasoning === "string").toBe(true);

    // Second-to-last chunk has finish_reason
    const last = JSON.parse(dataLines[dataLines.length - 2]);
    expectChunkShape(last);
    expect(last.choices[0].finish_reason).toEqual(expect.any(String));

    // All chunks share same id
    const ids = dataLines.filter((d) => d !== "[DONE]").map((d) => JSON.parse(d).id);
    expect(new Set(ids).size).toBe(1);
  });

  it("anthropic streaming completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const dataLines = parseSSE(text);
    expect(dataLines.length).toBeGreaterThanOrEqual(3);
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    const first = JSON.parse(dataLines[0]);
    expectChunkShape(first);
    expect(first.choices[0].delta.role).toBe("assistant");
  });

  it("codex streaming completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-5.1",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const dataLines = parseSSE(text);
    expect(dataLines.length).toBeGreaterThanOrEqual(3);
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    const first = JSON.parse(dataLines[0]);
    expectChunkShape(first);
    expect(first.choices[0].delta.role).toBe("assistant");
  });

  it("gemini streaming completion", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 32,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const dataLines = parseSSE(text);
    expect(dataLines.length).toBeGreaterThanOrEqual(3);
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    const first = JSON.parse(dataLines[0]);
    expectChunkShape(first);
    expect(first.choices[0].delta.role).toBe("assistant");
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

  it("stream=true with unknown model returns 404", async () => {
    const res = await post("/v1/chat/completions", {
      model: "nonexistent-model-xyz",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.code).toBe("model_not_found");
  });
});

// ── Image pipeline helpers ──────────────────────────────────────────────

function imageMessage(url: string, text?: string) {
  const content: { type: string; text?: string; image_url?: { url: string } }[] = [];
  if (text) content.push({ type: "text", text });
  content.push({ type: "image_url", image_url: { url } });
  return { role: "user", content };
}

// ── Image: direct vision ─────────────────────────────────────────────────

describe("image: direct vision", () => {
  it("ollama vision + data URI", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "llava:latest",
      messages: [imageMessage(dataUriJpeg, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("ollama vision + HTTPS URL", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "llava:latest",
      messages: [imageMessage(HTTPS_IMAGE_URL, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("anthropic vision + data URI", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "claude-haiku-4-5",
      messages: [imageMessage(dataUriJpeg, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("anthropic vision + HTTPS URL", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "claude-haiku-4-5",
      messages: [imageMessage(HTTPS_IMAGE_URL, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("codex vision + data URI", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-5.1",
      messages: [imageMessage(dataUriJpeg, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("codex vision + HTTPS URL", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gpt-5.1",
      messages: [imageMessage(HTTPS_IMAGE_URL, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("gemini vision + data URI", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gemini-2.0-flash",
      messages: [imageMessage(dataUriJpeg, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("gemini vision + HTTPS URL", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "gemini-2.0-flash",
      messages: [imageMessage(HTTPS_IMAGE_URL, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });
});

// ── Image: vision fallback ───────────────────────────────────────────────

describe("image: vision fallback", () => {
  it("ollama text-only + fallback", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "qwen3:30b",
      messages: [imageMessage(dataUriJpeg, "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });
});

// ── Image: streaming ────────────────────────────────────────────────────

describe("image: streaming", () => {
  it("streaming vision + data URI", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "llava:latest",
      messages: [imageMessage(dataUriJpeg, "Describe this image briefly.")],
      max_tokens: 64,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const dataLines = parseSSE(text);
    expect(dataLines.length).toBeGreaterThanOrEqual(3);
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    const first = JSON.parse(dataLines[0]);
    expectChunkShape(first);
    expect(first.choices[0].delta.role).toBe("assistant");
  });
});

// ── Phase 3: context window management ──────────────────────────────────

describe("phase 3: context window management", () => {
  it("models include context_window and max_tokens", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const json = await res.json();

    for (const model of json.data) {
      expect(model.context_window).toEqual(expect.any(Number));
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.max_tokens).toEqual(expect.any(Number));
      expect(model.max_tokens).toBeGreaterThan(0);
    }
  });

  it.skip("large context succeeds with num_ctx override", { timeout: 180_000 }, async () => {
    // Skipped: sending enough tokens to exceed default num_ctx makes the test
    // too slow for routine CI. Unit tests cover num_ctx injection logic.
    const filler = "word ".repeat(3000);
    const res = await post("/v1/chat/completions", {
      model: "qwen3:30b",
      messages: [{ role: "user", content: `${filler}What is 2+2? Reply with just the number.` }],
      max_tokens: 16,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectCompletionShape(json);
  });

  it("anthropic context overflow returns 400", { timeout: 60_000 }, async () => {
    // ~300k tokens to exceed claude-haiku-4-5's 200k context window
    const massive = "word ".repeat(300_000);
    const res = await post("/v1/chat/completions", {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: massive }],
      max_tokens: 32,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.code).toBe("context_length_exceeded");
  });
});

// ── Image: error handling ───────────────────────────────────────────────

describe("image: error handling", () => {
  it("invalid image data URI returns 400", { timeout: 60_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: "llava:latest",
      messages: [imageMessage("data:image/jpeg;base64,", "Describe this image briefly.")],
      max_tokens: 64,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("invalid_request_error");
  });
});
