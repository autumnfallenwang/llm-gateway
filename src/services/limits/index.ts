/**
 * How much of each paid family's allowance is left, per model (docs/usage-limits.md).
 *
 * One store per provider account, fed two ways: for free by every response (Claude's
 * `anthropic-ratelimit-unified-*` headers, Codex's `codex.rate_limits` event or `x-codex-*`
 * headers), and on demand by each family's account-usage endpoint, fetched when the cached
 * copy is older than LIMITS_CACHE_MS. Chat never waits on any of it and never fails
 * because of it.
 */
import {
  LIMITS_CACHE_MS,
  LIMITS_FETCH_TIMEOUT_MS,
  LIMITS_STALE_MS,
  LIMITS_WARN_BALANCE,
  LIMITS_WARN_PERCENT,
} from "../../config.js";
import { log } from "../../lib/logger.js";
import {
  ensureAnthropicFresh,
  ensureHostCredentialsFresh,
  getAnthropicKey,
  getCodexKey,
  getDeepseekKey,
} from "../auth.js";
import { listModels, type ResolvedModel } from "../registry.js";
import {
  type AccountLimits,
  ALL_MODELS,
  type LimitStatus,
  type LimitWindow,
  parseClaudeHeaders,
  parseClaudeUsage,
  parseCodexEvent,
  parseCodexHeaders,
  parseCodexUsage,
  parseDeepseekBalance,
  type Thresholds,
  worst,
} from "./parse.js";

export type { LimitStatus, LimitWindow } from "./parse.js";

/** A paid family's account (ResolvedModel.provider values). */
type Family = "anthropic" | "codex" | "deepseek";

export interface LimitsView {
  /** The model asked about (its listed ID), or null for a whole family. */
  model: string | null;
  /** `owned_by`. */
  provider: string;
  plan: string | null;
  status: LimitStatus | "unknown" | "unavailable";
  /** The one line a chatbot shows. */
  available:
    | { kind: "percent"; percent_left: number; resets_at: string | null; binding: string }
    | { kind: "balance"; amount: number; currency: string }
    | { kind: "unlimited" }
    | { kind: "unknown" }
    | { kind: "unavailable"; reason: string };
  /** Every window that applies to the model (all of the family's, for a family). */
  windows: LimitWindow[];
  balance: { amount: number; currency: string } | null;
  /** Family-specific extras, raw; not guaranteed stable. */
  details: Record<string, unknown>;
  as_of: string | null;
  source: "response" | "usage endpoint" | null;
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Each provider's `owned_by` — the name the API, model IDs and logs use for it. */
const OWNED_BY: Record<ResolvedModel["provider"], string> = {
  anthropic: "anthropic",
  codex: "openai-codex",
  deepseek: "deepseek",
  ollama: "ollama",
};

const OWNED_BY_FAMILY = Object.fromEntries(
  Object.entries(OWNED_BY).map(([family, owner]) => [owner, family]),
) as Record<string, ResolvedModel["provider"]>;

const thresholds = (): Thresholds => ({
  warnPercent: LIMITS_WARN_PERCENT,
  warnBalance: LIMITS_WARN_BALANCE,
});

// ── Store ────────────────────────────────────────────────────────────────────

interface Snapshot {
  data: AccountLimits;
  at: number;
}

interface FamilyState {
  /** The last account-usage endpoint result. */
  fetched?: Snapshot;
  /** The last limits a response carried. */
  observed?: Snapshot;
  inFlight?: Promise<void>;
  error?: string;
}

const state = new Map<Family, FamilyState>();

function stateOf(family: Family): FamilyState {
  let s = state.get(family);
  if (!s) {
    s = {};
    state.set(family, s);
  }
  return s;
}

/** For tests. */
export function resetLimits(): void {
  state.clear();
}

const HEADER_PARSERS: Partial<
  Record<
    ResolvedModel["provider"],
    (h: Record<string, string>, t: Thresholds) => AccountLimits | undefined
  >
> = {
  anthropic: parseClaudeHeaders,
  codex: parseCodexHeaders,
};

/** Record the limits a response's headers carry (Claude; Codex over SSE). Never throws. */
export function observeResponseHeaders(
  provider: ResolvedModel["provider"],
  headers: Record<string, string>,
): void {
  try {
    const data = HEADER_PARSERS[provider]?.(headers, thresholds());
    if (data) stateOf(provider as Family).observed = { data, at: Date.now() };
  } catch (err) {
    log.debug(
      { event: "limits.observe_failed", provider: OWNED_BY[provider], err },
      "Couldn't read limit headers",
    );
  }
}

/** Record the limits a stream event carries (Codex over WebSocket). Never throws. */
export function observeStreamEvent(provider: ResolvedModel["provider"], data: unknown): void {
  if (provider !== "codex") return;
  try {
    const limits = parseCodexEvent(data, thresholds());
    if (limits) stateOf("codex").observed = { data: limits, at: Date.now() };
  } catch (err) {
    log.debug(
      { event: "limits.observe_failed", provider: OWNED_BY[provider], err },
      "Couldn't read a limits event",
    );
  }
}

// ── Account-usage endpoints ──────────────────────────────────────────────────

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(LIMITS_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${res.status}`);
  return res.json();
}

function codexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

const FETCH: Record<Family, () => Promise<AccountLimits>> = {
  anthropic: async () => {
    await ensureAnthropicFresh();
    const key = getAnthropicKey();
    if (!key) throw new Error("no Anthropic credentials");
    const json = await getJson(CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${key}`,
      "anthropic-beta": "oauth-2025-04-20",
    });
    return parseClaudeUsage(json, thresholds());
  },
  codex: async () => {
    await ensureHostCredentialsFresh("codex");
    const key = getCodexKey();
    if (!key) throw new Error("no Codex credentials");
    const account = codexAccountId(key);
    // `originator: pi` is how the gateway already identifies to this backend, through pi-ai.
    const json = await getJson(CODEX_USAGE_URL, {
      Authorization: `Bearer ${key}`,
      originator: "pi",
      ...(account && { "chatgpt-account-id": account }),
    });
    return parseCodexUsage(json, thresholds());
  },
  deepseek: async () => {
    await ensureHostCredentialsFresh("deepseek");
    const key = getDeepseekKey();
    if (!key) throw new Error("no DeepSeek key");
    return parseDeepseekBalance(
      await getJson(DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${key}` }),
      thresholds(),
    );
  },
};

/** Fetch a family's usage endpoint; concurrent callers share one fetch. Never throws. */
function refresh(family: Family): Promise<void> {
  const s = stateOf(family);
  if (s.inFlight) return s.inFlight;
  s.inFlight = (async () => {
    try {
      s.fetched = { data: await FETCH[family](), at: Date.now() };
      s.error = undefined;
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
      log.warn(
        { event: "limits.fetch_failed", provider: OWNED_BY[family], err_message: s.error },
        "Couldn't fetch account usage — serving the last known limits",
      );
    }
  })().finally(() => {
    s.inFlight = undefined;
  });
  return s.inFlight;
}

async function ensureFetched(family: Family): Promise<void> {
  const { fetched } = stateOf(family);
  if (!fetched || Date.now() - fetched.at > LIMITS_CACHE_MS) await refresh(family);
}

// ── Views ────────────────────────────────────────────────────────────────────

const windowKey = (w: LimitWindow) => `${w.scope}|${w.period}`;

/** The endpoint's limits, with a newer response's windows and verdict laid over them. */
function current(
  family: Family,
): { data: AccountLimits; at: number; source: LimitsView["source"] } | undefined {
  const { fetched, observed } = stateOf(family);
  if (!observed || (fetched && fetched.at >= observed.at)) {
    return fetched && { ...fetched, source: "usage endpoint" };
  }
  if (!fetched) return { ...observed, source: "response" };
  const fresh = new Map(observed.data.windows.map((w) => [windowKey(w), w]));
  const known = new Set(fetched.data.windows.map(windowKey));
  return {
    data: {
      ...fetched.data,
      plan: observed.data.plan ?? fetched.data.plan,
      status: observed.data.status ?? fetched.data.status,
      windows: [
        ...fetched.data.windows.map((w) => fresh.get(windowKey(w)) ?? w),
        ...observed.data.windows.filter((w) => !known.has(windowKey(w))),
      ],
      details: { ...fetched.data.details, ...observed.data.details },
    },
    at: observed.at,
    source: "response",
  };
}

/** Whether a window counts against a model: account-wide, or scoped to the model's family. */
function appliesTo(w: LimitWindow, modelId: string): boolean {
  if (w.scope === ALL_MODELS) return true;
  const scope = w.scope.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return new RegExp(`(^|[^a-z0-9])${scope}([^a-z0-9]|$)`).test(modelId.toLowerCase());
}

const unlimited = (model: string | null, provider: string): LimitsView => ({
  model,
  provider,
  plan: null,
  status: "ok",
  available: { kind: "unlimited" },
  windows: [],
  balance: null,
  details: {},
  as_of: null,
  source: null,
});

function view(family: Family, provider: string, model: string | null): LimitsView {
  const s = stateOf(family);
  const now = current(family);
  const error = s.error ? { last_error: s.error } : {};
  if (!now) {
    return {
      ...unlimited(model, provider),
      status: "unknown",
      available: { kind: "unknown" },
      details: error,
    };
  }
  const { data } = now;
  const windows = model ? data.windows.filter((w) => appliesTo(w, model)) : data.windows;
  // A family as a whole is bound by its account-wide windows; a model by every one it has.
  const counted = model ? windows : windows.filter((w) => w.scope === ALL_MODELS);
  const binding = counted.reduce<LimitWindow | undefined>(
    (max, w) => (!max || w.used_percent > max.used_percent ? w : max),
    undefined,
  );
  let available: LimitsView["available"] = { kind: "unknown" };
  if (data.balance) available = { kind: "balance", ...data.balance };
  else if (binding) {
    available = {
      kind: "percent",
      percent_left: Math.max(0, Math.round((100 - binding.used_percent) * 10) / 10),
      resets_at: binding.resets_at,
      binding: `${binding.period} · ${binding.scope}`,
    };
  }
  const stale = Date.now() - now.at > LIMITS_STALE_MS;
  return {
    model,
    provider,
    plan: data.plan,
    status: stale ? "unknown" : worst([data.status, ...counted.map((w) => w.status)]),
    available,
    windows,
    balance: data.balance,
    details: { ...data.details, ...error },
    as_of: new Date(now.at).toISOString(),
    source: now.source,
  };
}

/** A model's last check, as `/v1/models` reports it (`POST /v1/models/validate`). */
export interface ModelCheck {
  status: "ok" | "error";
  error?: string;
}

/**
 * A model's limits now, fetching its family's usage endpoint if the cached copy is old.
 * A model that failed its last check — not on the plan, say — is `unavailable` with the
 * reason, however much of the account's allowance is left.
 */
export async function limitsFor(resolved: ResolvedModel, check?: ModelCheck): Promise<LimitsView> {
  let limits: LimitsView;
  if (resolved.provider === "ollama") limits = unlimited(resolved.id, resolved.model.provider);
  else {
    await ensureFetched(resolved.provider);
    limits = view(resolved.provider, resolved.model.provider, resolved.id);
  }
  if (check?.status !== "error") return limits;
  return {
    ...limits,
    status: "unavailable",
    available: { kind: "unavailable", reason: check.error ?? "The model failed its last check" },
  };
}

/** A model's limits from what's already cached, without fetching (for logging). */
export function peekLimits(resolved: ResolvedModel): LimitsView | undefined {
  if (resolved.provider === "ollama") return undefined;
  return view(resolved.provider, resolved.model.provider, resolved.id);
}

/** Every registered family's account-wide limits. */
export async function allLimits(): Promise<LimitsView[]> {
  const providers = [...new Set(listModels().map((m) => m.owned_by))];
  await Promise.all(
    providers.map((p) => {
      const family = OWNED_BY_FAMILY[p];
      return family && family !== "ollama" ? ensureFetched(family) : undefined;
    }),
  );
  return providers.map((p) => {
    const family = OWNED_BY_FAMILY[p];
    return family && family !== "ollama" ? view(family, p, null) : unlimited(null, p);
  });
}
