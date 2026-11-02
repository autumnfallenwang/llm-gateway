/**
 * Live check of GET /v1/limits through the gateway (docs/usage-limits.md), with the host's
 * real GPT (ChatGPT) login, DeepSeek key and local Ollama.
 *
 * Opt-in; a few account-usage fetches and two tiny chat requests:
 *
 *   npm run test:limits-poc
 *
 * Claude is left out: loading the host's Claude login into a local gateway would mint a
 * new chain and rotate it. Check Claude on the cluster, whose gateway has its own chain.
 */
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.LIMITS_POC === "1";

/** The POC's findings are its point, so print them. */
function report(data: unknown) {
  // biome-ignore lint/suspicious/noConsole: the POC's output is a report for a human
  console.info(JSON.stringify(data, null, 1));
}

describe.skipIf(!RUN)("GET /v1/limits, live", () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    // src/config.ts reads these at import time, so set them before any gateway import.
    process.env.ANTHROPIC_SEED_PATH = "/nonexistent";

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

  const limits = async (model?: string) => {
    const res = await fetch(
      `${baseUrl}/v1/limits${model ? `?model=${encodeURIComponent(model)}` : ""}`,
    );
    return { status: res.status, json: await res.json() };
  };

  const chat = (model: string) =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
      }),
    });

  it("lists every family: GPT in percent, DeepSeek in money, Ollama unlimited", {
    timeout: 60_000,
  }, async () => {
    const { status, json } = await limits();
    expect(status).toBe(200);
    const byProvider = Object.fromEntries(
      json.data.map((l: { provider: string; available: unknown }) => [l.provider, l.available]),
    );
    report(byProvider);
    expect(byProvider["openai-codex"]).toMatchObject({ kind: "percent" });
    expect(byProvider.deepseek).toMatchObject({ kind: "balance", currency: "USD" });
    expect(byProvider.ollama).toEqual({ kind: "unlimited" });
    expect(byProvider.anthropic).toBeUndefined();
  });

  it("gives a GPT model its Go plan's monthly window", { timeout: 60_000 }, async () => {
    const { status, json } = await limits("gpt-6-luna");
    expect(status).toBe(200);
    report(json);
    expect(json).toMatchObject({ model: "gpt-6-luna", provider: "openai-codex", plan: "go" });
    expect(json.windows[0]).toMatchObject({ scope: "all models", period: "monthly" });
    expect(json.available.binding).toBe("monthly · all models");
    expect(Date.parse(json.as_of)).toBeGreaterThan(Date.now() - 120_000);
  });

  it("takes fresher GPT limits from a chat response's stream event", {
    timeout: 120_000,
  }, async () => {
    expect((await chat("openai-codex/gpt-6-luna")).status).toBe(200);
    const { json } = await limits("openai-codex/gpt-6-luna");
    expect(json.source).toBe("response");
    expect(json.windows[0]?.period).toBe("monthly");
  });

  it("gives a DeepSeek model the prepaid balance, before and after a request", {
    timeout: 120_000,
  }, async () => {
    const before = (await limits("deepseek/deepseek-flash")).json;
    report(before.available);
    expect(before.available.amount).toBeGreaterThan(0);
    expect((await chat("deepseek-flash")).status).toBe(200);
    const after = (await limits("deepseek-flash")).json;
    expect(after).toMatchObject({ plan: "prepaid", available: { kind: "balance" } });
  });

  it("calls a local model unlimited and rejects an unknown one", async () => {
    expect((await limits("ollama/qwen3:30b")).json.available).toEqual({ kind: "unlimited" });
    expect((await limits("nobody/qwen3:30b")).status).toBe(404);
  });
});
