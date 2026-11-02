/**
 * Live proof-of-concept: does a ChatGPT Go subscription work through pi-ai's
 * `openai-codex` backend, and through the gateway on top of it?
 *
 * Opt-in. It makes ~35 real requests and spends the account's Codex quota:
 *
 *   npm run test:codex-poc
 *
 * It reads the Codex CLI login at CODEX_CREDENTIALS_PATH (default ~/.codex/auth.json;
 * `codex login` writes it). CODEX_POC_MODEL picks the model the feature tests use; the
 * default is one Go accepted when this was written (2026-11-01: gpt-5.6-luna,
 * gpt-5.6-terra, gpt-6-luna; the other catalog models answer "not supported when using
 * Codex with a ChatGPT account", which the gateway returns as a 404).
 *
 * It runs Codex-only: Anthropic and Ollama point at nothing before the gateway modules
 * load, so it never refreshes the host's Claude login or loads Ollama models on the GPU.
 */
import { readFileSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.CODEX_POC === "1";
const POC_MODEL = process.env.CODEX_POC_MODEL ?? "gpt-6-luna";
// A catalog model the Go plan refuses, for the error-path test.
const REFUSED_MODEL = process.env.CODEX_POC_REFUSED_MODEL ?? "gpt-6-sol";
// The backend's answer for a model the ChatGPT plan doesn't include.
const NOT_ON_PLAN = /not supported when using Codex with a ChatGPT account/i;

type Pi = typeof import("../src/lib/pi.js");
type Message = import("../src/lib/pi.js").Message;
type AssistantMessage = import("../src/lib/pi.js").AssistantMessage;
type ToolCall = import("../src/lib/pi.js").ToolCall;
type Tool = import("../src/lib/pi.js").Tool;

let pi: Pi;
let apiKey: string;
let redPng: Buffer;
/** Filled by the pi-ai probe: model id → whether this plan answered it. */
const planAccepts = new Map<string, boolean>();

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};
// JSON Schema at runtime; pi-ai types it as a TypeBox schema (as completion.ts toTool does).
const PI_WEATHER_TOOL = WEATHER_TOOL as unknown as Tool;
const WEATHER_RESULT = '{"temp_c": 17, "conditions": "light rain"}';

function user(content: Extract<Message, { role: "user" }>["content"]): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function textOf(msg: AssistantMessage): string {
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

function toolCallOf(msg: AssistantMessage): ToolCall | undefined {
  return msg.content.find((c): c is ToolCall => c.type === "toolCall");
}

/** Fails with the backend's own message when a call errors, instead of a bare stopReason diff. */
function expectNoError(msg: AssistantMessage) {
  expect(msg.errorMessage ?? "").toBe("");
  expect(msg.stopReason).not.toBe("error");
}

/** The POC's findings (plan, which models work) are its point, so print them. */
function report(data: unknown) {
  // biome-ignore lint/suspicious/noConsole: the POC's output is a report for a human
  typeof data === "string" ? console.info(data) : console.table(data);
}

function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
}

describe.skipIf(!RUN)("ChatGPT Go subscription via Codex", () => {
  beforeAll(async () => {
    // src/config.ts reads these at import time, so set them before any gateway import.
    process.env.ANTHROPIC_SEED_PATH = "/nonexistent";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
    process.env.CODEX_ENABLED = "true";

    pi = await import("../src/lib/pi.js");
    const { CODEX_CREDENTIALS_PATH } = await import("../src/config.js");
    const auth = JSON.parse(readFileSync(CODEX_CREDENTIALS_PATH, "utf-8"));
    apiKey = auth.tokens?.access_token;

    redPng = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
  });

  // ── The login ──────────────────────────────────────────────────────────────

  describe("login", () => {
    it("has an unexpired ChatGPT access token, and says which plan", () => {
      expect(apiKey, "no tokens.access_token in the Codex auth file").toEqual(expect.any(String));
      const claims = jwtClaims(apiKey);
      const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
      const exp = new Date((claims.exp as number) * 1000);
      report(`Codex login: plan=${auth?.chatgpt_plan_type}, expires ${exp.toISOString()}`);
      expect(exp.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ── pi-ai, called directly ─────────────────────────────────────────────────

  describe("pi-ai", () => {
    function model(id = POC_MODEL) {
      const found = pi.getModels("openai-codex").find((m) => m.id === id);
      if (!found) throw new Error(`${id} is not in pi-ai's openai-codex catalog`);
      return found;
    }

    interface Ask {
      id?: string;
      systemPrompt?: string;
      tools?: Tool[];
      /** Extra pi-ai stream options (toolChoice, reasoningEffort, ...). */
      options?: Record<string, unknown>;
    }

    function ask(messages: Message[], o: Ask = {}) {
      return pi.complete(
        model(o.id),
        {
          systemPrompt: o.systemPrompt ?? "You are a terse assistant.",
          messages,
          ...(o.tools && { tools: o.tools }),
        },
        { apiKey, signal: AbortSignal.timeout(90_000), ...o.options },
      );
    }

    it("probes every catalog model: which ones this plan accepts", {
      timeout: 300_000,
    }, async () => {
      const rows: { model: string; status: string; ms: number; detail: string }[] = [];
      // Sequential, so the probe itself doesn't trip the plan's rate limit.
      for (const m of pi.getModels("openai-codex")) {
        const start = Date.now();
        const res = await ask([user("Reply with exactly: pong")], { id: m.id });
        const ok = res.stopReason !== "error";
        planAccepts.set(m.id, ok);
        rows.push({
          model: m.id,
          status: ok ? "ok" : "refused",
          ms: Date.now() - start,
          detail: ok ? textOf(res) : (res.errorMessage ?? ""),
        });
      }
      report(rows);

      // Any failure other than "not on your plan" (expired login, network, a pi-ai
      // regression) should fail here rather than pass as a plan limit.
      for (const row of rows.filter((r) => r.status !== "ok")) {
        expect(row.detail, row.model).toMatch(NOT_ON_PLAN);
      }
      expect(rows.find((r) => r.model === POC_MODEL)?.status).toBe("ok");
    });

    it("completes a plain request with usage", { timeout: 120_000 }, async () => {
      const res = await ask([user("Reply with exactly: pong")]);
      expectNoError(res);
      expect(res.stopReason).toBe("stop");
      expect(textOf(res)).toMatch(/pong/i);
      expect(res.usage.input).toBeGreaterThan(0);
      expect(res.usage.output).toBeGreaterThan(0);
    });

    it("streams text deltas that add up to the final message", { timeout: 120_000 }, async () => {
      const events = pi.stream(
        model(),
        { systemPrompt: "You are a terse assistant.", messages: [user("Count from 1 to 5.")] },
        { apiKey, signal: AbortSignal.timeout(90_000) },
      );
      const deltas: string[] = [];
      const seen = new Set<string>();
      for await (const event of events) {
        seen.add(event.type);
        if (event.type === "text_delta") deltas.push(event.delta);
      }
      const final = await events.result();
      expectNoError(final);
      expect(seen.has("start")).toBe(true);
      expect(seen.has("done")).toBe(true);
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join("")).toBe(textOf(final));
      expect(textOf(final)).toMatch(/1.*2.*3.*4.*5/s);
    });

    it("follows the system prompt", { timeout: 120_000 }, async () => {
      const res = await ask([user("What is 2 + 2?")], {
        systemPrompt: "Whatever the user says, reply with only the word BANANA.",
      });
      expectNoError(res);
      expect(textOf(res)).toMatch(/banana/i);
    });

    it("keeps context across turns", { timeout: 120_000 }, async () => {
      const first = user("The code word is ZEBRA-42. Reply with just OK.");
      const reply = await ask([first]);
      expectNoError(reply);
      const res = await ask([first, reply, user("What is the code word? Reply with just it.")]);
      expectNoError(res);
      expect(textOf(res)).toMatch(/ZEBRA-42/i);
    });

    it("calls a tool, then answers from its result", { timeout: 120_000 }, async () => {
      const tools = [PI_WEATHER_TOOL];
      const question = user("What's the weather in Paris right now? Use the tool.");
      const first = await ask([question], { tools });
      expectNoError(first);
      expect(first.stopReason).toBe("toolUse");
      const call = toolCallOf(first);
      expect(call?.name).toBe("get_weather");
      expect(String(call?.arguments.city)).toMatch(/paris/i);

      const second = await ask(
        [
          question,
          first,
          {
            role: "toolResult",
            toolCallId: call?.id ?? "",
            toolName: "get_weather",
            content: [{ type: "text", text: WEATHER_RESULT }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
        { tools },
      );
      expectNoError(second);
      expect(second.stopReason).toBe("stop");
      expect(textOf(second)).toMatch(/17/);
    });

    // The gateway never forwards tool_choice to Codex (completion.ts withToolChoice);
    // this shows whether the backend would honour it.
    it("forces a tool call with toolChoice: required", { timeout: 120_000 }, async () => {
      const res = await ask([user("Say hi.")], {
        tools: [PI_WEATHER_TOOL],
        options: { toolChoice: "required" },
      });
      expectNoError(res);
      expect(res.stopReason).toBe("toolUse");
      expect(toolCallOf(res)?.name).toBe("get_weather");
    });

    it("reads an image", { timeout: 120_000 }, async () => {
      expect(model().input).toContain("image");
      const res = await ask([
        user([
          { type: "text", text: "What color is this image? Answer with one word." },
          { type: "image", data: redPng.toString("base64"), mimeType: "image/png" },
        ]),
      ]);
      expectNoError(res);
      expect(textOf(res)).toMatch(/red/i);
    });

    it("accepts a reasoning effort", { timeout: 120_000 }, async () => {
      const res = await ask([user("What is 17 * 23? Reply with just the number.")], {
        options: { reasoningEffort: "high" },
      });
      expectNoError(res);
      expect(textOf(res)).toMatch(/391/);
    });
  });

  // ── The gateway's OpenAI-compatible HTTP API ───────────────────────────────

  describe("gateway", () => {
    let server: ServerType;
    let baseUrl: string;

    beforeAll(async () => {
      const { openDb, setDb } = await import("../src/lib/db.js");
      const { loadCredentials } = await import("../src/services/auth.js");
      const { loadRegistry } = await import("../src/services/registry.js");
      const { default: app } = await import("../src/app.js");

      setDb(openDb(":memory:"));
      await loadCredentials();
      await loadRegistry();
      server = serve({ fetch: app.fetch, port: 0 });
      const addr = server.address();
      baseUrl = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
    }, 30_000);

    afterAll(() => {
      server?.close();
    });

    function chat(body: Record<string, unknown>) {
      return fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: POC_MODEL, ...body }),
      });
    }

    it("lists the Codex models, and only those", async () => {
      const json = await (await fetch(`${baseUrl}/v1/models`)).json();
      const owners = new Set(json.data.map((m: { owned_by: string }) => m.owned_by));
      expect([...owners]).toEqual(["openai-codex"]);
      expect(json.data.map((m: { id: string }) => m.id)).toContain(POC_MODEL);
    });

    it("answers a chat completion", { timeout: 120_000 }, async () => {
      const res = await chat({ messages: [{ role: "user", content: "Reply with exactly: pong" }] });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(json.object).toBe("chat.completion");
      expect(json.choices[0].message.content).toMatch(/pong/i);
      expect(json.choices[0].finish_reason).toBe("stop");
      expect(json.usage.total_tokens).toBeGreaterThan(0);
    });

    it("streams a chat completion as SSE", { timeout: 120_000 }, async () => {
      const res = await chat({
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        stream: true,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const data = (await res.text())
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      expect(data[data.length - 1]).toBe("[DONE]");
      const chunks = data.slice(0, -1).map((d) => JSON.parse(d));
      const content = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
      expect(content).toMatch(/pong/i);
      expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
    });

    it("round-trips an OpenAI tool call", { timeout: 120_000 }, async () => {
      const tools = [
        {
          type: "function",
          function: {
            name: WEATHER_TOOL.name,
            description: WEATHER_TOOL.description,
            parameters: WEATHER_TOOL.parameters,
          },
        },
      ];
      const question = {
        role: "user",
        content: "What's the weather in Paris right now? Use the tool.",
      };
      const first = await (await chat({ messages: [question], tools })).json();
      expect(first.choices?.[0]?.finish_reason, JSON.stringify(first)).toBe("tool_calls");
      const call = first.choices[0].message.tool_calls[0];
      expect(call.function.name).toBe("get_weather");
      expect(JSON.parse(call.function.arguments).city).toMatch(/paris/i);

      const second = await (
        await chat({
          messages: [
            question,
            first.choices[0].message,
            { role: "tool", tool_call_id: call.id, content: WEATHER_RESULT },
          ],
          tools,
        })
      ).json();
      expect(second.choices?.[0]?.finish_reason, JSON.stringify(second)).toBe("stop");
      expect(second.choices[0].message.content).toMatch(/17/);
    });

    it("reads an image sent as a data URI", { timeout: 120_000 }, async () => {
      const res = await chat({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What color is this image? Answer with one word." },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${redPng.toString("base64")}` },
              },
            ],
          },
        ],
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(json.choices[0].message.content).toMatch(/red/i);
    });

    it("returns an OpenAI error for a model the plan refuses", { timeout: 120_000 }, async () => {
      const res = await chat({
        model: REFUSED_MODEL,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(404);
      expect(json.error).toMatchObject({ code: "model_not_found", param: "model" });
      expect(json.error.message).toMatch(NOT_ON_PLAN);
    });

    // The Codex backend rejects temperature outright; OpenAI clients send it all the time.
    it("accepts temperature, which the backend itself rejects", { timeout: 120_000 }, async () => {
      const res = await chat({
        temperature: 0.2,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
      });
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      expect(json.choices[0].message.content).toMatch(/pong/i);
    });

    it("forces a tool call with tool_choice", { timeout: 120_000 }, async () => {
      const weather = {
        type: "function",
        function: {
          name: WEATHER_TOOL.name,
          description: WEATHER_TOOL.description,
          parameters: WEATHER_TOOL.parameters,
        },
      };
      const time = {
        type: "function",
        function: {
          name: "get_time",
          description: "Get the current time in a city.",
          parameters: WEATHER_TOOL.parameters,
        },
      };
      const sayHi = [{ role: "user", content: "Say hi." }];

      const required = await (
        await chat({ messages: sayHi, tools: [weather, time], tool_choice: "required" })
      ).json();
      expect(required.choices?.[0]?.finish_reason, JSON.stringify(required)).toBe("tool_calls");

      const named = await (
        await chat({
          messages: sayHi,
          tools: [weather, time],
          tool_choice: { type: "function", function: { name: "get_time" } },
        })
      ).json();
      expect(named.choices?.[0]?.finish_reason, JSON.stringify(named)).toBe("tool_calls");
      expect(named.choices[0].message.tool_calls[0].function.name).toBe("get_time");
    });

    it("takes a reasoning_effort, from none to high", { timeout: 180_000 }, async () => {
      for (const reasoningEffort of ["none", "high"]) {
        const res = await chat({
          reasoning_effort: reasoningEffort,
          messages: [{ role: "user", content: "What is 17 * 23? Reply with just the number." }],
        });
        const json = await res.json();
        expect(res.status, `${reasoningEffort}: ${JSON.stringify(json)}`).toBe(200);
        expect(json.choices[0].message.content).toMatch(/391/);
      }
    });

    it("validation reports which Codex models this plan can use", {
      timeout: 300_000,
    }, async () => {
      const res = await fetch(`${baseUrl}/v1/models/validate`, { method: "POST" });
      expect(res.status).toBe(200);
      const validation = await res.json();
      report(
        Object.entries(validation.models as Record<string, { status: string; error?: string }>).map(
          ([id, r]) => ({ model: id, status: r.status, error: r.error?.slice(0, 90) ?? "" }),
        ),
      );
      expect(validation.models[POC_MODEL].status).toBe("ok");
      // The gateway agrees with pi-ai on which models this plan can use, and says why not.
      for (const [id, accepted] of planAccepts) {
        expect(validation.models[id]?.status, id).toBe(accepted ? "ok" : "error");
        if (!accepted) expect(validation.models[id]?.error, id).toMatch(NOT_ON_PLAN);
      }

      const listed = await (await fetch(`${baseUrl}/v1/models`)).json();
      expect(listed.data.find((m: { id: string }) => m.id === POC_MODEL)?.status).toBe("ok");
    });
  });
});
