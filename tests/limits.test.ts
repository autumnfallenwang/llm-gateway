import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseClaudeHeaders,
  parseClaudeUsage,
  parseCodexEvent,
  parseCodexHeaders,
  parseCodexUsage,
  parseDeepseekBalance,
  periodOf,
} from "../src/services/limits/parse";

// Fixtures: the shapes the POCs captured live on 2026-11-02 (docs/usage-limits.md), scrubbed.
const CLAUDE_USAGE = {
  five_hour: null,
  seven_day: { utilization: 43, resets_at: "2026-11-06T10:00:00.267656+00:00" },
  extra_usage: {
    is_enabled: false,
    monthly_limit: 1000,
    used_credits: 0,
    currency: "USD",
    disabled_reason: "out_of_credits",
  },
  limits: [
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 43,
      severity: "normal",
      resets_at: "2026-11-06T10:00:00.267656+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 4,
      severity: "normal",
      resets_at: "2026-11-06T10:00:00.267792+00:00",
      scope: { model: { display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  seven_day_breakdown: {
    rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }],
  },
};

const CLAUDE_HEADERS = {
  "anthropic-ratelimit-unified-7d-reset": "1793959200",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.42",
  "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": "1793959200",
  "anthropic-ratelimit-unified-status": "allowed",
};

const CODEX_USAGE = {
  plan_type: "go",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 2592000,
      reset_after_seconds: 2580538,
      reset_at: 1796183729,
    },
    secondary_window: null,
  },
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, balance: null },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
};

const CODEX_EVENT = {
  type: "codex.rate_limits",
  plan_type: "go",
  rate_limits: {
    allowed: true,
    limit_reached: false,
    primary: {
      used_percent: 0,
      window_minutes: 43200,
      reset_after_seconds: 2580539,
      reset_at: 1796183729,
    },
    secondary: null,
  },
  credits: { has_credits: false, unlimited: false, balance: null },
};

const CODEX_HEADERS = {
  "x-codex-active-limit": "premium",
  "x-codex-plan-type": "go",
  "x-codex-primary-used-percent": "0",
  "x-codex-primary-window-minutes": "43200",
  "x-codex-primary-reset-at": "1796183729",
  "x-codex-secondary-used-percent": "0",
  "x-codex-secondary-window-minutes": "0",
  "x-codex-secondary-reset-at": "",
};

const DEEPSEEK_BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: "USD", total_balance: "9.96", granted_balance: "0.00", topped_up_balance: "9.96" },
  ],
};

const T = { warnPercent: 80, warnBalance: 1 };

describe("parsers", () => {
  it("names window lengths the way the official clients do", () => {
    expect([300, 1440, 10080, 43200, 720, 90].map(periodOf)).toEqual([
      "5h",
      "daily",
      "weekly",
      "monthly",
      "12h",
      "90m",
    ]);
  });

  it("reads Claude's usage endpoint: weekly all-models and the Fable-scoped window", () => {
    const limits = parseClaudeUsage(CLAUDE_USAGE, T);
    expect(limits.windows).toEqual([
      {
        scope: "all models",
        period: "weekly",
        used_percent: 43,
        resets_at: "2026-11-06T10:00:00.267Z",
        status: "ok",
      },
      {
        scope: "Fable",
        period: "weekly",
        used_percent: 4,
        resets_at: "2026-11-06T10:00:00.267Z",
        status: "ok",
      },
    ]);
    expect(limits.details).toMatchObject({
      extra_usage: { enabled: false, disabled_reason: "out_of_credits" },
      weekly_breakdown: [{ key: "claude_code", percent: 100 }],
    });
  });

  it("falls back to Claude's per-window objects, including a 5-hour window", () => {
    const limits = parseClaudeUsage(
      {
        five_hour: { utilization: 61, resets_at: "2026-11-02T12:00:00Z" },
        seven_day: { utilization: 20, resets_at: "2026-11-06T10:00:00Z" },
      },
      T,
    );
    expect(limits.windows.map((w) => [w.period, w.used_percent])).toEqual([
      ["5h", 61],
      ["weekly", 20],
    ]);
  });

  it("reads Claude's response headers", () => {
    const limits = parseClaudeHeaders(CLAUDE_HEADERS, T);
    expect(limits?.status).toBe("ok");
    expect(limits?.windows).toEqual([
      {
        scope: "all models",
        period: "weekly",
        used_percent: 42,
        resets_at: "2026-11-06T10:00:00.000Z",
        status: "ok",
      },
    ]);
    expect(limits?.details).toMatchObject({
      binding_claim: "seven_day",
      overage_status: "rejected",
    });
  });

  it("reads a 5-hour window and Claude's own warning and rejection from headers", () => {
    const limits = parseClaudeHeaders(
      {
        ...CLAUDE_HEADERS,
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "0.65",
        "anthropic-ratelimit-unified-5h-reset": "1793900000",
        "anthropic-ratelimit-unified-5h-status": "allowed_warning",
      },
      T,
    );
    expect(limits?.status).toBe("exhausted");
    expect(limits?.windows[0]).toMatchObject({ period: "5h", used_percent: 65, status: "warning" });
  });

  it("finds nothing in a response without Claude's headers", () => {
    expect(parseClaudeHeaders({ "content-type": "text/event-stream" }, T)).toBeUndefined();
  });

  it("reads Codex's usage endpoint: Go's one monthly window", () => {
    const limits = parseCodexUsage(CODEX_USAGE, T);
    expect(limits.plan).toBe("go");
    expect(limits.windows).toEqual([
      {
        scope: "all models",
        period: "monthly",
        used_percent: 0,
        resets_at: "2026-12-02T03:55:29.000Z",
        status: "ok",
      },
    ]);
    expect(limits.details).toMatchObject({ reset_credits: { available_count: 3 } });
  });

  it("marks a reached Codex limit exhausted", () => {
    const usage = structuredClone(CODEX_USAGE);
    usage.rate_limit.limit_reached = true;
    usage.rate_limit.allowed = false;
    usage.rate_limit.primary_window.used_percent = 100;
    const limits = parseCodexUsage(usage, T);
    expect(limits.status).toBe("exhausted");
    expect(limits.windows[0]?.status).toBe("exhausted");
  });

  it("reads the codex.rate_limits event and ignores other events", () => {
    expect(parseCodexEvent(CODEX_EVENT, T)?.windows[0]).toMatchObject({
      period: "monthly",
      used_percent: 0,
    });
    expect(parseCodexEvent({ type: "response.created" }, T)).toBeUndefined();
  });

  it("reads Codex's headers, skipping an absent secondary window", () => {
    const limits = parseCodexHeaders(CODEX_HEADERS, T);
    expect(limits?.plan).toBe("go");
    expect(limits?.windows).toHaveLength(1);
    expect(limits?.windows[0]?.period).toBe("monthly");
  });

  it("reads DeepSeek's balance and its thresholds", () => {
    expect(parseDeepseekBalance(DEEPSEEK_BALANCE, T)).toMatchObject({
      plan: "prepaid",
      status: "ok",
      balance: { amount: 9.96, currency: "USD" },
      windows: [],
    });
    const low = structuredClone(DEEPSEEK_BALANCE);
    low.balance_infos[0].total_balance = "0.40";
    expect(parseDeepseekBalance(low, T).status).toBe("warning");
    low.balance_infos[0].total_balance = "0.00";
    expect(parseDeepseekBalance(low, T).status).toBe("exhausted");
    expect(parseDeepseekBalance({ ...DEEPSEEK_BALANCE, is_available: false }, T).status).toBe(
      "exhausted",
    );
  });

  it("warns at the threshold and calls 100% exhausted", () => {
    const at = (percent: number) =>
      parseClaudeUsage({ limits: [{ group: "weekly", percent, severity: "normal" }] }, T).windows[0]
        ?.status;
    expect([at(79), at(80), at(100)]).toEqual(["ok", "warning", "exhausted"]);
  });
});

// ── The store and per-model views ────────────────────────────────────────────

vi.mock("../src/services/auth", () => ({
  ensureAnthropicFresh: vi.fn(async () => undefined),
  ensureHostCredentialsFresh: vi.fn(async () => undefined),
  getAnthropicKey: () => "anthropic-token",
  getCodexKey: () =>
    "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdCJ9fQ.sig",
  getDeepseekKey: () => "sk-test",
}));

const listModelsMock = vi.fn(() => [] as { owned_by: string }[]);
vi.mock("../src/services/registry", () => ({ listModels: () => listModelsMock() }));

const {
  allLimits,
  limitsFor,
  observeResponseHeaders,
  observeStreamEvent,
  peekLimits,
  resetLimits,
} = await import("../src/services/limits/index");

const fetchMock = vi.fn<typeof fetch>();

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function model(provider: "anthropic" | "codex" | "deepseek" | "ollama", id: string) {
  const ownedBy = provider === "codex" ? "openai-codex" : provider;
  return { id, model: { id, provider: ownedBy }, provider, capability: "chat" } as never;
}

beforeEach(() => {
  resetLimits();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("limits for a model", () => {
  it("gives a Fable model both windows, bound by the fuller one", async () => {
    fetchMock.mockResolvedValueOnce(respond(CLAUDE_USAGE));
    const limits = await limitsFor(model("anthropic", "claude-fable-5-1"));
    expect(limits.windows.map((w) => w.scope)).toEqual(["all models", "Fable"]);
    expect(limits.available).toEqual({
      kind: "percent",
      percent_left: 57,
      resets_at: "2026-11-06T10:00:00.267Z",
      binding: "weekly · all models",
    });
    expect(limits).toMatchObject({ status: "ok", source: "usage endpoint", provider: "anthropic" });
  });

  it("gives other Claude models only the account-wide window", async () => {
    fetchMock.mockResolvedValueOnce(respond(CLAUDE_USAGE));
    const limits = await limitsFor(model("anthropic", "claude-sonnet-5-5"));
    expect(limits.windows.map((w) => w.scope)).toEqual(["all models"]);
  });

  it("sends the account-usage endpoints what they need", async () => {
    fetchMock.mockResolvedValueOnce(respond(CLAUDE_USAGE));
    await limitsFor(model("anthropic", "claude-haiku-5-5"));
    fetchMock.mockResolvedValueOnce(respond(CODEX_USAGE));
    await limitsFor(model("codex", "gpt-6-luna"));
    const [[claudeUrl, claude], [codexUrl, codex]] = fetchMock.mock.calls as [
      string,
      RequestInit,
    ][];
    expect(claudeUrl).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(claude.headers).toMatchObject({
      Authorization: "Bearer anthropic-token",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(codexUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(codex.headers).toMatchObject({ "chatgpt-account-id": "acct", originator: "pi" });
  });

  it("fetches once per cache period, and once for concurrent callers", async () => {
    fetchMock.mockImplementation(async () => respond(CLAUDE_USAGE));
    await Promise.all([
      limitsFor(model("anthropic", "claude-haiku-5-5")),
      limitsFor(model("anthropic", "claude-opus-5-5")),
    ]);
    await limitsFor(model("anthropic", "claude-fable-5-1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lays a newer response's windows over the endpoint's, keeping the scoped one", async () => {
    fetchMock.mockResolvedValueOnce(respond(CLAUDE_USAGE));
    await limitsFor(model("anthropic", "claude-fable-5-1"));
    await new Promise((r) => setTimeout(r, 5));
    observeResponseHeaders("anthropic", CLAUDE_HEADERS);

    const limits = peekLimits(model("anthropic", "claude-fable-5-1"));
    expect(limits?.source).toBe("response");
    expect(limits?.windows.map((w) => [w.scope, w.used_percent])).toEqual([
      ["all models", 42],
      ["Fable", 4],
    ]);
  });

  it("takes Codex's limits from the stream event, before any endpoint fetch", () => {
    observeStreamEvent("codex", CODEX_EVENT);
    const limits = peekLimits(model("codex", "gpt-6-luna"));
    expect(limits).toMatchObject({ plan: "go", source: "response", provider: "openai-codex" });
    expect(limits?.available).toMatchObject({ kind: "percent", percent_left: 100 });
  });

  it("shows DeepSeek's balance", async () => {
    fetchMock.mockResolvedValueOnce(respond(DEEPSEEK_BALANCE));
    const limits = await limitsFor(model("deepseek", "deepseek-flash"));
    expect(limits.available).toEqual({ kind: "balance", amount: 9.96, currency: "USD" });
    expect(limits.status).toBe("ok");
  });

  it("calls Ollama models unlimited, without fetching anything", async () => {
    const limits = await limitsFor(model("ollama", "qwen3:30b"));
    expect(limits.available).toEqual({ kind: "unlimited" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unknown, with the reason, when the endpoint fails and nothing is cached", async () => {
    fetchMock.mockResolvedValueOnce(respond({}, 503));
    const limits = await limitsFor(model("deepseek", "deepseek-flash"));
    expect(limits).toMatchObject({ status: "unknown", available: { kind: "unknown" } });
    expect(String(limits.details.last_error)).toContain("HTTP 503");
  });

  it("keeps serving the last data when a later fetch fails, then calls it stale", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-02T08:00:00Z"), toFake: ["Date"] });
    fetchMock.mockResolvedValueOnce(respond(DEEPSEEK_BALANCE));
    await limitsFor(model("deepseek", "deepseek-flash"));

    vi.setSystemTime(new Date("2026-11-02T08:05:00Z")); // past the cache, before stale
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const kept = await limitsFor(model("deepseek", "deepseek-flash"));
    expect(kept.available).toMatchObject({ kind: "balance", amount: 9.96 });
    expect(kept.status).toBe("ok");
    expect(kept.details.last_error).toBe("network down");

    vi.setSystemTime(new Date("2026-11-02T08:20:00Z")); // past stale
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect((await limitsFor(model("deepseek", "deepseek-flash"))).status).toBe("unknown");
  });

  it("lists every registered family account-wide", async () => {
    listModelsMock.mockReturnValue([
      { owned_by: "ollama" },
      { owned_by: "anthropic" },
      { owned_by: "anthropic" },
      { owned_by: "deepseek" },
    ]);
    fetchMock.mockImplementation(async (url) =>
      respond(String(url).includes("anthropic") ? CLAUDE_USAGE : DEEPSEEK_BALANCE),
    );
    const all = await allLimits();
    expect(all.map((l) => [l.provider, l.available.kind])).toEqual([
      ["ollama", "unlimited"],
      ["anthropic", "percent"],
      ["deepseek", "balance"],
    ]);
    // A family's view lists every window but is bound by the account-wide one.
    expect(all[1]?.windows).toHaveLength(2);
    expect(all[1]?.model).toBeNull();
  });
});
