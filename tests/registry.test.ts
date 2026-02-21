import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCredentials } from "../src/services/auth";
import { listModels, loadRegistry, resolveModel } from "../src/services/registry";

// ── Mock Ollama server ──────────────────────────────────────────────────────

const OLLAMA_MODELS = [
  { id: "llama3:latest", object: "model", created: 1700000000, owned_by: "library" },
  { id: "codellama:7b", object: "model", created: 1700000001, owned_by: "library" },
  { id: "llava:latest", object: "model", created: 1700000002, owned_by: "library" },
];

const SHOW_CAPABILITIES: Record<
  string,
  { capabilities?: string[]; model_info?: Record<string, unknown> }
> = {
  "llama3:latest": {
    capabilities: ["completion"],
    model_info: { "llama3.context_length": 8192 },
  },
  "codellama:7b": {
    capabilities: ["completion"],
    model_info: { "codellama.context_length": 16384 },
  },
  "llava:latest": {
    capabilities: ["completion", "vision"],
    model_info: { "llava.context_length": 4096 },
  },
};

let ollamaServer: Server;
let ollamaPort: number;

beforeAll(async () => {
  ollamaServer = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: OLLAMA_MODELS }));
    } else if (req.method === "POST" && req.url === "/api/show") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const { name } = JSON.parse(body) as { name: string };
        const caps = SHOW_CAPABILITIES[name];
        if (caps) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(caps));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    ollamaServer.listen(0, () => resolve());
  });
  const addr = ollamaServer.address();
  ollamaPort = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    ollamaServer.close((err) => (err ? reject(err) : resolve()));
  });
});

// ── Auth temp files ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "registry-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function anthropicPath(): string {
  return join(tempDir, "anthropic.json");
}

function codexPath(): string {
  return join(tempDir, "codex.json");
}

function geminiPath(): string {
  return join(tempDir, "gemini.json");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

async function setupAnthropicKey(): Promise<void> {
  await writeFile(
    anthropicPath(),
    JSON.stringify({
      claudeAiOauth: { accessToken: "anthropic-tok-test", expiresAt: Date.now() + 3_600_000 },
    }),
  );
}

async function setupCodexKey(): Promise<void> {
  const jwt = makeJwt({ sub: "user", exp: Math.floor(Date.now() / 1000) + 3600 });
  await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("loadRegistry", () => {
  it("discovers Ollama models from mock server", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    const ollamaIds = models.filter((m) => m.owned_by === "ollama").map((m) => m.id);
    expect(ollamaIds).toContain("llama3:latest");
    expect(ollamaIds).toContain("codellama:7b");
  });

  it("loads Anthropic models when key is available", async () => {
    await setupAnthropicKey();
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" }); // no Ollama

    const models = listModels();
    const anthropicIds = models.filter((m) => m.owned_by === "anthropic").map((m) => m.id);
    expect(anthropicIds.length).toBeGreaterThan(0);
    expect(anthropicIds).toContain("claude-3-5-haiku-20241022");
  });

  it("loads Codex models when key is available", async () => {
    await setupCodexKey();
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" }); // no Ollama

    const models = listModels();
    const codexIds = models.filter((m) => m.owned_by === "openai-codex").map((m) => m.id);
    expect(codexIds.length).toBeGreaterThan(0);
  });

  it("skips Anthropic models when no key", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    const anthropicIds = models.filter((m) => m.owned_by === "anthropic");
    expect(anthropicIds).toHaveLength(0);
  });

  it("skips Codex models when no key", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    const codexIds = models.filter((m) => m.owned_by === "openai-codex");
    expect(codexIds).toHaveLength(0);
  });

  it("skips Gemini models when no key", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    const geminiIds = models.filter((m) => m.owned_by === "google-gemini-cli");
    expect(geminiIds).toHaveLength(0);
  });

  it("detects vision-capable Ollama model", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llava:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.model.input).toEqual(["text", "image"]);
  });

  it("keeps non-vision Ollama model as text-only", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llama3:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.model.input).toEqual(["text"]);
  });

  it("uses context_length from /api/show", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llava:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.model.contextWindow).toBe(4096);
  });

  it("handles Ollama not running gracefully", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    // Port 1 should refuse connections
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" });

    const models = listModels();
    const ollamaIds = models.filter((m) => m.owned_by === "ollama");
    expect(ollamaIds).toHaveLength(0);
  });
});

describe("listModels", () => {
  it("returns correct OpenAI-format objects", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    expect(models.length).toBeGreaterThan(0);

    for (const m of models) {
      expect(m).toHaveProperty("id");
      expect(m.object).toBe("model");
      expect(typeof m.created).toBe("number");
      expect(typeof m.owned_by).toBe("string");
    }
  });
});

describe("resolveModel", () => {
  it("resolves an Ollama model with provider='ollama'", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llama3:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.provider).toBe("ollama");
    expect(resolved?.model.id).toBe("llama3:latest");
    expect(resolved?.apiKey).toBeUndefined();
  });

  it("resolves an Anthropic model with apiKey", async () => {
    await setupAnthropicKey();
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" });

    const resolved = resolveModel("claude-3-5-haiku-20241022");
    expect(resolved).toBeDefined();
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.apiKey).toBe("anthropic-tok-test");
  });

  it("resolves a Codex model with apiKey", async () => {
    await setupCodexKey();
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" });

    const models = listModels();
    const codexModel = models.find((m) => m.owned_by === "openai-codex");
    expect(codexModel).toBeDefined();

    const resolved = resolveModel(codexModel?.id ?? "");
    expect(resolved).toBeDefined();
    expect(resolved?.provider).toBe("codex");
    expect(resolved?.apiKey).toBeDefined();
  });

  it("returns undefined for nonexistent model", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("nonexistent-model-xyz");
    expect(resolved).toBeUndefined();
  });
});
