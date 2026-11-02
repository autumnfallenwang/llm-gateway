import { afterEach, describe, expect, it, vi } from "vitest";

const anthropicStream = vi.fn();
const completionsStream = vi.fn();
const codexStream = vi.fn();

vi.mock("@earendil-works/pi-ai/api/anthropic-messages", () => ({ stream: anthropicStream }));
vi.mock("@earendil-works/pi-ai/api/openai-completions", () => ({ stream: completionsStream }));
vi.mock("@earendil-works/pi-ai/api/openai-codex-responses", () => ({ stream: codexStream }));

const { getModels, reasoningOptions, stream } = await import("../src/lib/pi");

type Compat = { supportsTemperature?: boolean };

function claude(id: string) {
  const model = getModels("anthropic").find((m) => m.id === id);
  if (!model) throw new Error(`${id} not in the catalog`);
  return model;
}

function gpt(id: string) {
  const model = getModels("openai-codex").find((m) => m.id === id);
  if (!model) throw new Error(`${id} not in the catalog`);
  return model;
}

function deepseek(id: string) {
  const model = getModels("deepseek").find((m) => m.id === id);
  if (!model) throw new Error(`${id} not in the catalog`);
  return model;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("catalog corrections", () => {
  it("marks claude-sonnet-5 and claude-fable-5 as refusing temperature", () => {
    for (const id of ["claude-sonnet-5", "claude-fable-5"]) {
      expect((claude(id).compat as Compat).supportsTemperature).toBe(false);
    }
  });

  it("leaves other models as pi-ai has them", () => {
    expect(
      (claude("claude-sonnet-4-6").compat as Compat | undefined)?.supportsTemperature,
    ).not.toBe(false);
  });

  // "Codex error: Unsupported parameter: temperature", checked live 2026-11-01.
  it("marks every Codex model as refusing temperature", () => {
    for (const model of getModels("openai-codex")) {
      expect((model.compat as Compat).supportsTemperature, model.id).toBe(false);
    }
  });
});

describe("retired models", () => {
  const ids = () => getModels("anthropic").map((m) => m.id);

  it("lists claude-sonnet-4-5 until its retirement date", () => {
    vi.useFakeTimers({ now: new Date("2026-11-29T23:59:00Z") });
    expect(ids()).toContain("claude-sonnet-4-5");
    expect(ids()).toContain("claude-sonnet-4-5-20250929");
  });

  it("drops claude-sonnet-4-5 from its retirement date on", () => {
    vi.useFakeTimers({ now: new Date("2026-11-30T00:00:00Z") });
    expect(ids()).not.toContain("claude-sonnet-4-5");
    expect(ids()).not.toContain("claude-sonnet-4-5-20250929");
    expect(ids()).toContain("claude-sonnet-4-6");
  });
});

describe("temperature", () => {
  const context = { messages: [] };

  it("drops it for Codex, whose backend rejects it and pi-ai sends it anyway", () => {
    stream(gpt("gpt-6-luna"), context, { apiKey: "k", temperature: 0.2 });
    const options = codexStream.mock.calls[0]?.[2] as { temperature?: number };
    expect(options.temperature).toBeUndefined();
  });

  it("keeps it where the model takes it", () => {
    stream(claude("claude-haiku-4-5"), context, { apiKey: "k", temperature: 0.2 });
    const options = anthropicStream.mock.calls[0]?.[2] as { temperature?: number };
    expect(options.temperature).toBe(0.2);
  });
});

describe("reasoningOptions", () => {
  it("passes the level to Codex, which pi-ai maps per model", () => {
    expect(reasoningOptions(gpt("gpt-6-luna"), "high")).toEqual({ reasoningEffort: "high" });
    expect(reasoningOptions(gpt("gpt-6-luna"), "none")).toEqual({ reasoningEffort: "none" });
  });

  it("moves none to the lowest level on a Codex model that always reasons", () => {
    expect(reasoningOptions(gpt("gpt-6.1-sol"), "none")).toEqual({ reasoningEffort: "minimal" });
  });

  it("sets an adaptive Claude model's effort", () => {
    expect(reasoningOptions(claude("claude-opus-4-8"), "xhigh")).toEqual({
      thinkingEnabled: true,
      effort: "xhigh",
    });
    expect(reasoningOptions(claude("claude-opus-5-5"), "medium")).toEqual({
      thinkingEnabled: true,
      effort: "medium",
    });
  });

  it("moves a level the model lacks to the nearest one it has", () => {
    // Opus 4.6 has no xhigh (pi-ai rounds up first); Haiku 5.5 has no minimal.
    expect(reasoningOptions(claude("claude-opus-4-6"), "xhigh")).toEqual({
      thinkingEnabled: true,
      effort: "max",
    });
    expect(reasoningOptions(claude("claude-haiku-5-5"), "minimal")).toEqual({
      thinkingEnabled: true,
      effort: "low",
    });
  });

  it("turns thinking off for none where the model allows it", () => {
    expect(reasoningOptions(claude("claude-haiku-5-5"), "none")).toEqual({
      thinkingEnabled: false,
    });
  });

  it("uses the lowest effort for none on a Claude model that always thinks", () => {
    expect(reasoningOptions(claude("claude-opus-5-5"), "none")).toEqual({
      thinkingEnabled: true,
      effort: "low",
    });
  });

  it("gives budget-thinking Claude models a budget that fits inside max_tokens", () => {
    const opts = reasoningOptions(claude("claude-haiku-4-5"), "high", 100);
    expect(opts.thinkingEnabled).toBe(true);
    expect(opts.thinkingBudgetTokens).toBeGreaterThanOrEqual(1024);
    expect(opts.maxTokens as number).toBeGreaterThan(opts.thinkingBudgetTokens as number);
  });

  // pi-ai's DeepSeek backend thinks exactly when given a level (`thinking: enabled`).
  it("gives DeepSeek a level, moved to the nearest one the model has", () => {
    expect(reasoningOptions(deepseek("deepseek-flash"), "low")).toEqual({ reasoningEffort: "low" });
    // deepseek-v4-pro has only high and max; flash has no medium.
    expect(reasoningOptions(deepseek("deepseek-v4-pro"), "low")).toEqual({
      reasoningEffort: "high",
    });
    expect(reasoningOptions(deepseek("deepseek-flash"), "medium")).toEqual({
      reasoningEffort: "high",
    });
  });

  it("leaves DeepSeek's thinking off for none", () => {
    expect(reasoningOptions(deepseek("deepseek-v4-pro"), "none")).toEqual({});
  });

  it("leaves models that don't reason alone", () => {
    expect(reasoningOptions({ ...claude("claude-haiku-4-5"), reasoning: false }, "high")).toEqual(
      {},
    );
  });
});

describe("default max_tokens", () => {
  const context = { messages: [] };

  it("is a third of the model's maximum for Anthropic, as pi-ai 0.73 sent", () => {
    const model = claude("claude-haiku-4-5");
    stream(model, context, { apiKey: "k" });
    const options = anthropicStream.mock.calls[0]?.[2] as { maxTokens?: number };
    expect(options.maxTokens).toBe(Math.floor(model.maxTokens / 3));
  });

  it("keeps a max_tokens the caller set", () => {
    stream(claude("claude-haiku-4-5"), context, { apiKey: "k", maxTokens: 50 });
    const options = anthropicStream.mock.calls[0]?.[2] as { maxTokens?: number };
    expect(options.maxTokens).toBe(50);
  });

  it("adds nothing for OpenAI-compatible backends", () => {
    const ollama = { ...claude("claude-haiku-4-5"), api: "openai-completions" as const };
    stream(ollama, context, { apiKey: "k" });
    const options = completionsStream.mock.calls[0]?.[2] as { maxTokens?: number };
    expect(options.maxTokens).toBeUndefined();
  });
});
