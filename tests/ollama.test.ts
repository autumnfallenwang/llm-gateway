import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OLLAMA_DEFAULT_CONTEXT_WINDOW } from "../src/config";
import {
  buildOllamaModel,
  extractContextLength,
  fetchModelCapabilities,
  type OllamaShowResponse,
} from "../src/lib/ollama";

// ── Mock Ollama /api/show server ────────────────────────────────────────────

const SHOW_RESPONSES: Record<string, OllamaShowResponse> = {
  "llava:latest": {
    capabilities: ["completion", "vision"],
    model_info: { "llava.context_length": 4096 },
  },
  "llama3:latest": {
    capabilities: ["completion"],
    model_info: { "llama3.context_length": 8192 },
  },
  "bare-model": {
    // no capabilities field at all
    model_info: { "bare.context_length": 2048 },
  },
};

let showServer: Server;
let showPort: number;

beforeAll(async () => {
  showServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/show") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const { name } = JSON.parse(body) as { name: string };
        const response = SHOW_RESPONSES[name];
        if (response) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    showServer.listen(0, () => resolve());
  });
  const addr = showServer.address();
  showPort = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    showServer.close((err) => (err ? reject(err) : resolve()));
  });
});

// ── fetchModelCapabilities tests ────────────────────────────────────────────

describe("fetchModelCapabilities", () => {
  it("detects vision capability", async () => {
    const caps = await fetchModelCapabilities("llava:latest", `http://localhost:${showPort}`);
    expect(caps.supportsVision).toBe(true);
  });

  it("detects non-vision model", async () => {
    const caps = await fetchModelCapabilities("llama3:latest", `http://localhost:${showPort}`);
    expect(caps.supportsVision).toBe(false);
  });

  it("extracts context_length from model_info", async () => {
    const caps = await fetchModelCapabilities("llava:latest", `http://localhost:${showPort}`);
    expect(caps.contextLength).toBe(4096);
  });

  it("handles missing capabilities field", async () => {
    const caps = await fetchModelCapabilities("bare-model", `http://localhost:${showPort}`);
    expect(caps.supportsVision).toBe(false);
    expect(caps.contextLength).toBe(2048);
  });

  it("defaults on 404", async () => {
    const caps = await fetchModelCapabilities("nonexistent-model", `http://localhost:${showPort}`);
    expect(caps.supportsVision).toBe(false);
    expect(caps.contextLength).toBeUndefined();
  });

  it("defaults on connection refused", async () => {
    const caps = await fetchModelCapabilities("llava:latest", "http://localhost:1");
    expect(caps.supportsVision).toBe(false);
    expect(caps.contextLength).toBeUndefined();
  });

  it("defaults on timeout", async () => {
    // Create a server that never responds
    const slowServer = createServer(() => {
      // intentionally never respond
    });
    await new Promise<void>((resolve) => {
      slowServer.listen(0, () => resolve());
    });
    const addr = slowServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const caps = await fetchModelCapabilities(
        "llava:latest",
        `http://localhost:${port}`,
        50, // 50ms timeout
      );
      expect(caps.supportsVision).toBe(false);
      expect(caps.contextLength).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        slowServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

// ── extractContextLength tests ──────────────────────────────────────────────

describe("extractContextLength", () => {
  it("finds key ending in .context_length", () => {
    expect(extractContextLength({ "llama3.context_length": 8192 })).toBe(8192);
  });

  it("returns undefined when no matching key", () => {
    expect(extractContextLength({ some_other_key: 1234 })).toBeUndefined();
  });

  it("ignores non-positive values", () => {
    expect(extractContextLength({ "foo.context_length": 0 })).toBeUndefined();
    expect(extractContextLength({ "foo.context_length": -1 })).toBeUndefined();
  });

  it("ignores non-number values", () => {
    expect(extractContextLength({ "foo.context_length": "8192" })).toBeUndefined();
  });
});

// ── buildOllamaModel tests ──────────────────────────────────────────────────

describe("buildOllamaModel", () => {
  it('sets ["text", "image"] when vision', () => {
    const model = buildOllamaModel("llava:latest", undefined, {
      supportsVision: true,
    });
    expect(model.input).toEqual(["text", "image"]);
  });

  it('sets ["text"] when not vision', () => {
    const model = buildOllamaModel("llama3:latest", undefined, {
      supportsVision: false,
    });
    expect(model.input).toEqual(["text"]);
  });

  it("uses contextLength when provided", () => {
    const model = buildOllamaModel("llava:latest", undefined, {
      supportsVision: true,
      contextLength: 4096,
    });
    expect(model.contextWindow).toBe(4096);
  });

  it("falls back to default context window", () => {
    const model = buildOllamaModel("llama3:latest", undefined, {
      supportsVision: false,
    });
    expect(model.contextWindow).toBe(OLLAMA_DEFAULT_CONTEXT_WINDOW);
  });

  it("falls back to text-only when no capabilities arg", () => {
    const model = buildOllamaModel("some-model");
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(OLLAMA_DEFAULT_CONTEXT_WINDOW);
  });
});
