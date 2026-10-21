import { afterEach, describe, expect, it, vi } from "vitest";

const anthropicStream = vi.fn();
const completionsStream = vi.fn();

vi.mock("@earendil-works/pi-ai/api/anthropic-messages", () => ({ stream: anthropicStream }));
vi.mock("@earendil-works/pi-ai/api/openai-completions", () => ({ stream: completionsStream }));

const { getModels, stream } = await import("../src/lib/pi");

type Compat = { supportsTemperature?: boolean };

function claude(id: string) {
  const model = getModels("anthropic").find((m) => m.id === id);
  if (!model) throw new Error(`${id} not in the catalog`);
  return model;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("catalog corrections", () => {
  it("marks claude-sonnet-5 and claude-fable-5 as refusing temperature", () => {
    for (const id of ["claude-sonnet-5", "claude-fable-5"]) {
      expect((claude(id).compat as Compat).supportsTemperature).toBe(false);
    }
  });

  it("leaves other models as pi-ai has them", () => {
    expect(
      (claude("claude-sonnet-4-5").compat as Compat | undefined)?.supportsTemperature,
    ).not.toBe(false);
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
