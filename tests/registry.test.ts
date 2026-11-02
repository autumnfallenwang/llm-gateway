import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppDb, openDb, setDb } from "../src/lib/db";
import { loadCredentials } from "../src/services/auth";
import { listModels, loadRegistry, lookupModel, resolveModel } from "../src/services/registry";

// ── Mock Ollama server ──────────────────────────────────────────────────────

const OLLAMA_MODELS = [
  { id: "llama3:latest", object: "model", created: 1700000000, owned_by: "library" },
  { id: "codellama:7b", object: "model", created: 1700000001, owned_by: "library" },
  { id: "llava:latest", object: "model", created: 1700000002, owned_by: "library" },
  { id: "bge-m3:latest", object: "model", created: 1700000003, owned_by: "library" },
];

/** Extra models a test lists from the mock Ollama (names that collide, community names). */
let extraOllamaModels: typeof OLLAMA_MODELS = [];

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
  "bge-m3:latest": {
    capabilities: ["embedding"],
    model_info: { "bert.context_length": 8192 },
  },
};

let ollamaServer: Server;
let ollamaPort: number;

beforeAll(async () => {
  ollamaServer = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [...OLLAMA_MODELS, ...extraOllamaModels] }));
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
let db: AppDb;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "registry-test-"));
  db = openDb(":memory:");
  setDb(db);
});

afterEach(async () => {
  extraOllamaModels = [];
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

// Anthropic creds are seeded directly into the DB; the seed path points at a
// non-existent file so loadCredentials has nothing to bootstrap from when no DB
// row is set up.
function anthropicSeedPath(): string {
  return join(tempDir, "anthropic-seed-nonexistent.json");
}

function codexPath(): string {
  return join(tempDir, "codex.json");
}

function deepseekPath(): string {
  return join(tempDir, "deepseek_api_key");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function setupAnthropicKey(): void {
  db.writeCredentialChain("anthropic", {
    access: "anthropic-tok-test",
    refresh: "anthropic-refresh-test",
    expires: Date.now() + 3_600_000,
  });
}

async function setupDeepseekKey(): Promise<void> {
  await writeFile(deepseekPath(), "sk-test-deepseek\n");
}

async function setupCodexKey(): Promise<void> {
  const jwt = makeJwt({ sub: "user", exp: Math.floor(Date.now() / 1000) + 3600 });
  await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("loadRegistry", () => {
  it("discovers Ollama models from mock server", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    const ollamaIds = models.filter((m) => m.owned_by === "ollama").map((m) => m.id);
    expect(ollamaIds).toContain("llama3:latest");
    expect(ollamaIds).toContain("codellama:7b");
  });

  it("loads Anthropic models when key is available", async () => {
    setupAnthropicKey();
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" }); // no Ollama

    const models = listModels();
    const anthropicIds = models.filter((m) => m.owned_by === "anthropic").map((m) => m.id);
    expect(anthropicIds.length).toBeGreaterThan(0);
    // The current Claude 5 family, straight from pi-ai's catalog.
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ]) {
      expect(anthropicIds).toContain(id);
    }
  });

  it("loads Codex models when key is available", async () => {
    await setupCodexKey();
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" }); // no Ollama

    const models = listModels();
    const codexIds = models.filter((m) => m.owned_by === "openai-codex").map((m) => m.id);
    expect(codexIds.length).toBeGreaterThan(0);
  });

  it("skips Anthropic models when no key", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    const anthropicIds = models.filter((m) => m.owned_by === "anthropic");
    expect(anthropicIds).toHaveLength(0);
  });

  it("skips Codex models when no key", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    const codexIds = models.filter((m) => m.owned_by === "openai-codex");
    expect(codexIds).toHaveLength(0);
  });

  it("loads DeepSeek's models when its key file exists", async () => {
    await setupDeepseekKey();
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" }); // no Ollama

    const ids = listModels()
      .filter((m) => m.owned_by === "deepseek")
      .map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["deepseek-flash", "deepseek-v4-pro"]));
  });

  it("skips DeepSeek models without the key file", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" });

    expect(listModels().filter((m) => m.owned_by === "deepseek")).toHaveLength(0);
  });

  it("detects vision-capable Ollama model", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llava:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.model.input).toEqual(["text", "image"]);
  });

  it("keeps non-vision Ollama model as text-only", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llama3:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.model.input).toEqual(["text"]);
  });

  it("uses context_length from /api/show", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llava:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.model.contextWindow).toBe(4096);
  });

  it("tags embedding Ollama model as embedding capability", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("bge-m3:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.capability).toBe("embedding");
  });

  it("tags chat Ollama model as chat capability", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llama3:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.capability).toBe("chat");
  });

  it("tags vision Ollama model as chat capability (vision is not embedding)", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llava:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.capability).toBe("chat");
  });

  it("handles Ollama not running gracefully", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
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
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const models = listModels();
    expect(models.length).toBeGreaterThan(0);

    for (const m of models) {
      expect(m).toHaveProperty("id");
      expect(m.object).toBe("model");
      expect(typeof m.created).toBe("number");
      expect(typeof m.owned_by).toBe("string");
      expect(["chat", "embedding"]).toContain(m.capability);
    }
  });
});

describe("resolveModel", () => {
  it("resolves an Ollama model with provider='ollama'", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("llama3:latest");
    expect(resolved).toBeDefined();
    expect(resolved?.provider).toBe("ollama");
    expect(resolved?.model.id).toBe("llama3:latest");
    expect(resolved?.apiKey).toBeUndefined();
  });

  it("resolves an Anthropic model with apiKey", async () => {
    setupAnthropicKey();
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" });

    const resolved = resolveModel("claude-sonnet-5-5");
    expect(resolved).toBeDefined();
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.apiKey).toBe("anthropic-tok-test");
    expect(resolved?.capability).toBe("chat");
  });

  it("resolves a Codex model with apiKey", async () => {
    await setupCodexKey();
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
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

  it("resolves a DeepSeek model with its key", async () => {
    await setupDeepseekKey();
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: "http://localhost:1" });

    const resolved = resolveModel("deepseek-v4-pro");
    expect(resolved?.provider).toBe("deepseek");
    expect(resolved?.apiKey).toBe("sk-test-deepseek");
    expect(resolved?.model.input).toEqual(["text"]);
  });

  it("returns undefined for nonexistent model", async () => {
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });

    const resolved = resolveModel("nonexistent-model-xyz");
    expect(resolved).toBeUndefined();
  });
});

// ── Model IDs: provider/model (docs/model-ids.md) ─────────────────────────────

describe("model IDs", () => {
  const ollamaModel = (id: string) => ({
    id,
    object: "model",
    created: 1700000009,
    owned_by: "library",
  });

  async function loadEverything() {
    setupAnthropicKey();
    await setupCodexKey();
    await setupDeepseekKey();
    await loadCredentials({
      anthropicSeedPath: anthropicSeedPath(),
      codexCredentialsPath: codexPath(),
      deepseekCredentialsPath: deepseekPath(),
    });
    await loadRegistry({ ollamaBaseUrl: `http://localhost:${ollamaPort}` });
  }

  it("resolves owned_by/model for every provider, listed under the bare ID", async () => {
    await loadEverything();
    const codexId = listModels().find((m) => m.owned_by === "openai-codex")?.id ?? "";
    for (const [qualified, provider, id] of [
      ["ollama/llama3:latest", "ollama", "llama3:latest"],
      ["anthropic/claude-haiku-5-5", "anthropic", "claude-haiku-5-5"],
      [`openai-codex/${codexId}`, "codex", codexId],
      ["deepseek/deepseek-flash", "deepseek", "deepseek-flash"],
    ] as const) {
      const resolved = resolveModel(qualified);
      expect(resolved?.provider, qualified).toBe(provider);
      expect(resolved?.id, qualified).toBe(id);
    }
  });

  it("keeps bare IDs working when one provider lists them", async () => {
    await loadEverything();
    expect(resolveModel("claude-haiku-5-5")?.provider).toBe("anthropic");
    expect(resolveModel("llama3:latest")?.provider).toBe("ollama");
    const ids = listModels().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes("/"))).toBe(false);
  });

  describe("when two providers list the same ID", () => {
    beforeEach(() => {
      extraOllamaModels = [ollamaModel("deepseek-flash")];
    });

    it("lists each one qualified, and nothing under the bare ID", async () => {
      await loadEverything();
      const ids = listModels().map((m) => m.id);
      expect(ids).toContain("ollama/deepseek-flash");
      expect(ids).toContain("deepseek/deepseek-flash");
      expect(ids).not.toContain("deepseek-flash");
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("calls the bare ID ambiguous, naming both choices", async () => {
      await loadEverything();
      expect(lookupModel("deepseek-flash")).toEqual({
        kind: "ambiguous",
        choices: ["ollama/deepseek-flash", "deepseek/deepseek-flash"],
      });
      expect(resolveModel("deepseek-flash")).toBeUndefined();
    });

    it("resolves each qualified ID to its own provider", async () => {
      await loadEverything();
      expect(resolveModel("ollama/deepseek-flash")).toMatchObject({
        provider: "ollama",
        id: "ollama/deepseek-flash",
      });
      expect(resolveModel("deepseek/deepseek-flash")).toMatchObject({
        provider: "deepseek",
        id: "deepseek/deepseek-flash",
        apiKey: "sk-test-deepseek",
      });
    });
  });

  it("treats a slash as a prefix only for our providers' own models", async () => {
    // Ollama community names; one starts with a provider name but isn't that provider's model.
    extraOllamaModels = [ollamaModel("someuser/coder:7b"), ollamaModel("deepseek/coder:7b")];
    await loadEverything();
    expect(resolveModel("someuser/coder:7b")).toMatchObject({
      provider: "ollama",
      id: "someuser/coder:7b",
    });
    expect(resolveModel("deepseek/coder:7b")).toMatchObject({
      provider: "ollama",
      id: "deepseek/coder:7b",
    });
    expect(resolveModel("ollama/deepseek/coder:7b")?.provider).toBe("ollama");
  });

  it("finds nothing under an unknown prefix or another provider's name", async () => {
    await loadEverything();
    expect(lookupModel("nobody/llama3:latest")).toEqual({ kind: "missing" });
    expect(lookupModel("anthropic/llama3:latest")).toEqual({ kind: "missing" });
    expect(lookupModel("deepseek/")).toEqual({ kind: "missing" });
  });
});
