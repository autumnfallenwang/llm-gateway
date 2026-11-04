/**
 * Live check: DeepSeek's API models through the gateway, with the key from the host file
 * (`DEEPSEEK_CREDENTIALS_PATH`, default ~/.deepseek/api_key). See docs/deepseek-provider.md.
 *
 * Opt-in. It makes ~25 real requests and spends DeepSeek balance (well under a cent):
 *
 *   npm run test:deepseek-poc
 *
 * Anthropic and Codex point at nothing, so it never refreshes the host's Claude login or
 * spends the ChatGPT plan. Ollama is the real local one, but no Ollama model is loaded: the
 * suite never calls the validate route, and the vision fallback that describes images to
 * deepseek-v4-pro uses deepseek-flash (VISION_FALLBACK_DEEPSEEK).
 */
import { readFileSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.DEEPSEEK_POC === "1";
const FLASH = "deepseek-flash";
const PRO = "deepseek-v4-pro";

const WEATHER = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};
const TIME = {
  type: "function",
  function: { ...WEATHER.function, name: "get_time", description: "Get the time in a city." },
};

/** The suite's findings (which models, what they cost) are its point, so print them. */
function report(data: unknown) {
  // biome-ignore lint/suspicious/noConsole: the POC's output is a report for a human
  typeof data === "string" ? console.info(data) : console.table(data);
}

describe.skipIf(!RUN)("DeepSeek API through the gateway", () => {
  let server: ServerType;
  let baseUrl: string;
  let apiKey: string;
  let redPngUri: string;
  let bluePngUri: string;
  let catalogIds: string[];
  let validateSingleModel: typeof import("../src/services/validation.js").validateSingleModel;
  let resolveModel: typeof import("../src/services/registry.js").resolveModel;

  beforeAll(async () => {
    // src/config.ts reads these at import time, so set them before any gateway import.
    process.env.ANTHROPIC_SEED_PATH = "/nonexistent";
    process.env.CODEX_ENABLED = "false";

    const { DEEPSEEK_CREDENTIALS_PATH } = await import("../src/config.js");
    apiKey = readFileSync(DEEPSEEK_CREDENTIALS_PATH, "utf-8").trim();
    const { getModels } = await import("../src/lib/pi.js");
    catalogIds = getModels("deepseek").map((m) => m.id);

    const { openDb, setDb } = await import("../src/lib/db.js");
    const { loadCredentials } = await import("../src/services/auth.js");
    const registry = await import("../src/services/registry.js");
    ({ validateSingleModel } = await import("../src/services/validation.js"));
    resolveModel = registry.resolveModel;
    const { default: app } = await import("../src/app.js");

    setDb(openDb(":memory:"));
    await loadCredentials();
    await registry.loadRegistry();
    server = serve({ fetch: app.fetch, port: 0 });
    const addr = server.address();
    baseUrl = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const red = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    redPngUri = `data:image/png;base64,${red.toString("base64")}`;
    const blue = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    bluePngUri = `data:image/png;base64,${blue.toString("base64")}`;
  }, 30_000);

  afterAll(() => {
    server?.close();
  });

  function post(path: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function chat(body: Record<string, unknown>) {
    const res = await post("/v1/chat/completions", { model: FLASH, ...body });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    return json;
  }

  const pong = [{ role: "user", content: "Reply with exactly: pong" }];
  const math = [{ role: "user", content: "What is 17 * 23? Reply with just the number." }];

  // ── The key and the catalog ─────────────────────────────────────────────

  it("the key file holds a working key, and DeepSeek lists pi-ai's models", async () => {
    const res = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const live = ((await res.json()).data as { id: string }[]).map((m) => m.id).sort();
    report(`DeepSeek lists ${live.join(", ")}; pi-ai has ${[...catalogIds].sort().join(", ")}`);
    expect(live).toEqual([...catalogIds].sort());
  });

  it("lists both models as owned_by deepseek", async () => {
    const json = await (await fetch(`${baseUrl}/v1/models`)).json();
    const ours = json.data.filter((m: { owned_by: string }) => m.owned_by === "deepseek");
    report(
      ours.map((m: { id: string; context_window: number; max_tokens: number }) => ({
        model: m.id,
        context_window: m.context_window,
        max_tokens: m.max_tokens,
      })),
    );
    expect(ours.map((m: { id: string }) => m.id).sort()).toEqual([FLASH, PRO]);
  });

  // ── Chat ────────────────────────────────────────────────────────────────

  it("answers a chat completion with usage, on both models", { timeout: 120_000 }, async () => {
    for (const model of [FLASH, PRO]) {
      const json = await chat({ model, messages: pong });
      expect(json.choices[0].message.content, model).toMatch(/pong/i);
      expect(json.choices[0].finish_reason).toBe("stop");
      expect(json.usage.total_tokens).toBeGreaterThan(0);
    }
  });

  it("streams a chat completion as SSE", { timeout: 120_000 }, async () => {
    const res = await post("/v1/chat/completions", { model: FLASH, messages: pong, stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const data = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    expect(data[data.length - 1]).toBe("[DONE]");
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toMatch(/pong/i);
  });

  it("ends a stream with the usage when stream_options.include_usage is set", {
    timeout: 120_000,
  }, async () => {
    const res = await post("/v1/chat/completions", {
      model: FLASH,
      messages: pong,
      stream: true,
      stream_options: { include_usage: true },
    });
    const data = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    expect(data[data.length - 1]).toBe("[DONE]");
    const last = JSON.parse(data[data.length - 2] ?? "{}");
    report(last.usage);
    expect(last.choices).toEqual([]);
    expect(last.usage.total_tokens).toBeGreaterThan(0);
  });

  it("takes temperature", { timeout: 120_000 }, async () => {
    const json = await chat({ temperature: 0.2, messages: pong });
    expect(json.choices[0].message.content).toMatch(/pong/i);
  });

  // ── Reasoning ───────────────────────────────────────────────────────────

  it("thinks only when asked, at the nearest level", { timeout: 180_000 }, async () => {
    for (const reasoningEffort of [undefined, "none", "low", "max"]) {
      const json = await chat({ model: PRO, messages: math, reasoning_effort: reasoningEffort });
      expect(json.choices[0].message.content, String(reasoningEffort)).toMatch(/391/);
    }
  });

  // pi-ai's catalog lists only high/max for V4 Pro; DeepSeek takes low (pi.ts THINKING_LEVELS).
  it("sends deepseek-v4-pro the low effort asked for, not high", { timeout: 120_000 }, async () => {
    const { complete, reasoningOptions } = await import("../src/lib/pi.js");
    const model = resolveModel(PRO)?.model;
    if (!model) throw new Error(`${PRO} isn't registered`);
    const sent: unknown[] = [];
    const res = await complete(
      model,
      { messages: [{ role: "user", content: math[0]?.content ?? "", timestamp: Date.now() }] },
      {
        ...reasoningOptions(model, "low"),
        apiKey,
        onPayload: (payload: unknown) => {
          const p = payload as { reasoning_effort?: string; thinking?: unknown };
          sent.push(p.reasoning_effort, p.thinking);
        },
      },
    );
    expect(sent).toEqual(["low", { type: "enabled" }]);
    expect(res.stopReason, res.errorMessage).toBe("stop");
  });

  it("streams the reasoning as delta.reasoning", { timeout: 120_000 }, async () => {
    const res = await post("/v1/chat/completions", {
      model: PRO,
      messages: math,
      reasoning_effort: "high",
      stream: true,
    });
    const deltas = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)).choices[0]?.delta ?? {});
    expect(deltas.some((d) => typeof d.reasoning === "string" && d.reasoning.length > 0)).toBe(
      true,
    );
    expect(deltas.map((d) => d.content ?? "").join("")).toMatch(/391/);
  });

  // ── Tools ───────────────────────────────────────────────────────────────

  async function toolRoundTrip(model: string, extra: Record<string, unknown> = {}) {
    const question = {
      role: "user",
      content: "What's the weather in Paris right now? Use the tool.",
    };
    const first = await chat({ model, messages: [question], tools: [WEATHER], ...extra });
    expect(first.choices[0].finish_reason, JSON.stringify(first)).toBe("tool_calls");
    const call = first.choices[0].message.tool_calls[0];
    expect(JSON.parse(call.function.arguments).city).toMatch(/paris/i);
    // An OpenAI client sends back role/content/tool_calls only, never the reasoning.
    const second = await chat({
      model,
      tools: [WEATHER],
      ...extra,
      messages: [
        question,
        first.choices[0].message,
        { role: "tool", tool_call_id: call.id, content: '{"temp_c": 17}' },
      ],
    });
    expect(second.choices[0].message.content).toMatch(/17/);
  }

  it("round-trips a tool call", { timeout: 120_000 }, async () => {
    await toolRoundTrip(FLASH);
  });

  it("round-trips a tool call while thinking", { timeout: 180_000 }, async () => {
    await toolRoundTrip(PRO, { reasoning_effort: "high" });
  });

  it("forces a tool with tool_choice, even when asked to think", { timeout: 180_000 }, async () => {
    const sayHi = [{ role: "user", content: "Say hi." }];
    // DeepSeek can't force a tool while thinking; the gateway turns thinking off for it.
    for (const reasoningEffort of [undefined, "high"]) {
      const required = await chat({
        messages: sayHi,
        tools: [WEATHER, TIME],
        tool_choice: "required",
        reasoning_effort: reasoningEffort,
      });
      expect(required.choices[0].finish_reason, String(reasoningEffort)).toBe("tool_calls");
    }
    const named = await chat({
      messages: sayHi,
      tools: [WEATHER, TIME],
      tool_choice: { type: "function", function: { name: "get_time" } },
    });
    expect(named.choices[0].message.tool_calls[0].function.name).toBe("get_time");
  });

  // ── Images ──────────────────────────────────────────────────────────────

  const colourOf = (url: string) => [
    {
      role: "user",
      content: [
        { type: "text", text: "What color is this image? Answer with one word." },
        { type: "image_url", image_url: { url } },
      ],
    },
  ];

  it("reads an image on deepseek-flash", { timeout: 120_000 }, async () => {
    const json = await chat({ messages: colourOf(redPngUri) });
    expect(json.choices[0].message.content).toMatch(/red/i);
  });

  it("describes an image to the text-only deepseek-v4-pro via the fallback", {
    timeout: 180_000,
  }, async () => {
    const json = await chat({ model: PRO, messages: colourOf(redPngUri) });
    expect(json.choices[0].message.content).toMatch(/red/i);
  });

  // deepseek-flash describes each image on its own, in its place; the next turn re-sends the
  // same message, and the descriptions come from the cache.
  it("describes each of several images, once across turns", { timeout: 240_000 }, async () => {
    const { getDb } = await import("../src/lib/db.js");
    const stored = () =>
      (getDb().raw.prepare("SELECT COUNT(*) AS n FROM image_descriptions").get() as { n: number })
        .n;
    const before = stored();
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Here are two images." },
          { type: "image_url", image_url: { url: redPngUri } },
          { type: "text", text: "And the second:" },
          { type: "image_url", image_url: { url: bluePngUri } },
          { type: "text", text: "Name image 1's colour, then image 2's, as two words." },
        ],
      },
    ];
    const first = await chat({ model: PRO, messages });
    report(`two images, first turn: ${first.choices[0].message.content}`);
    expect(first.choices[0].message.content).toMatch(/red[\s\S]*blue/i);
    expect(stored()).toBe(before + 2);

    const start = Date.now();
    const again = await chat({ model: PRO, messages });
    report(`same message again: ${Date.now() - start} ms, ${again.choices[0].message.content}`);
    expect(again.choices[0].message.content).toMatch(/red[\s\S]*blue/i);
    expect(stored()).toBe(before + 2);
  });

  // ── Edges ───────────────────────────────────────────────────────────────

  it("has no embeddings: 501 provider_unsupported", async () => {
    const res = await post("/v1/embeddings", { model: FLASH, input: "hi" });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("provider_unsupported");
  });

  it("validates both models", { timeout: 120_000 }, async () => {
    for (const id of [FLASH, PRO]) {
      const resolved = resolveModel(id);
      expect(resolved, id).toBeDefined();
      const result = await validateSingleModel(resolved as NonNullable<typeof resolved>, 60_000);
      expect(result, id).toMatchObject({ status: "ok" });
    }
  });
});
