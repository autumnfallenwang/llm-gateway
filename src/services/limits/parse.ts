/**
 * Turn each paid family's raw limit data — an account-usage endpoint's JSON, a response's
 * headers, a stream event — into one shape. Pure functions; see docs/usage-limits.md for the
 * fields and where each comes from.
 */

export type LimitStatus = "ok" | "warning" | "exhausted";

/** A usage window: how much of one allowance is used, and when it resets. */
export interface LimitWindow {
  /** `all models`, or the model family a scoped limit covers (Claude's `Fable`). */
  scope: string;
  /** `5h`, `daily`, `weekly`, `monthly`, or a length like `12h`. */
  period: string;
  used_percent: number;
  resets_at: string | null;
  status: LimitStatus;
}

/** One provider account's limits, as one source reported them. */
export interface AccountLimits {
  plan: string | null;
  /** The provider's own overall verdict, when it gives one. */
  status: LimitStatus | null;
  windows: LimitWindow[];
  balance: { amount: number; currency: string } | null;
  details: Record<string, unknown>;
}

export interface Thresholds {
  /** A window at or above this percent used is a warning. */
  warnPercent: number;
  /** A balance below this is a warning. */
  warnBalance: number;
}

export const ALL_MODELS = "all models";

const RANK: Record<LimitStatus, number> = { ok: 0, warning: 1, exhausted: 2 };

export function worst(statuses: (LimitStatus | null | undefined)[]): LimitStatus {
  return statuses.reduce<LimitStatus>((acc, s) => (s && RANK[s] > RANK[acc] ? s : acc), "ok");
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** An epoch-seconds or ISO time as ISO, or null. */
function isoTime(v: unknown): string | null {
  const secs = num(v);
  if (secs !== undefined && secs > 0) return new Date(secs * 1000).toISOString();
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

/** A window length in minutes, named as the official clients name it. */
export function periodOf(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 1440) return "daily";
  if (minutes === 10080) return "weekly";
  if (minutes >= 40320 && minutes <= 44640) return "monthly";
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function windowStatus(used: number, t: Thresholds, provider?: LimitStatus): LimitStatus {
  if (used >= 100) return "exhausted";
  return worst([provider, used >= t.warnPercent ? "warning" : "ok"]);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Claude ───────────────────────────────────────────────────────────────────

const CLAUDE_STATUS: Record<string, LimitStatus> = {
  allowed: "ok",
  allowed_warning: "warning",
  rejected: "exhausted",
};

/** `limits[].severity`: `normal` is ok; anything else is at least a warning. */
function claudeSeverity(v: unknown): LimitStatus | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "normal") return "ok";
  return /critical|exceed|block|reject|limit/i.test(v) ? "exhausted" : "warning";
}

function claudePeriod(kind: string): string {
  if (/five|5h|session/i.test(kind)) return "5h";
  if (/week|7d|seven/i.test(kind)) return "weekly";
  if (/month/i.test(kind)) return "monthly";
  if (/day|daily/i.test(kind)) return "daily";
  return kind;
}

/** `GET api.anthropic.com/api/oauth/usage`. */
export function parseClaudeUsage(json: unknown, t: Thresholds): AccountLimits {
  const u = obj(json) ?? {};
  const windows: LimitWindow[] = [];
  if (Array.isArray(u.limits)) {
    for (const l of u.limits.map(obj)) {
      const used = num(l?.percent);
      if (!l || used === undefined) continue;
      const scope = obj(obj(l.scope)?.model)?.display_name;
      windows.push({
        scope: typeof scope === "string" && scope ? scope : ALL_MODELS,
        period: claudePeriod(String(l.group ?? l.kind ?? "")),
        used_percent: round(used),
        resets_at: isoTime(l.resets_at),
        status: windowStatus(used, t, claudeSeverity(l.severity)),
      });
    }
  }
  // The older shape — one object per account-wide window, utilization 0–100 — still comes
  // alongside `limits[]`. Take any window `limits[]` doesn't list, so a 5-hour window sent
  // only there isn't dropped.
  for (const [key, period] of [
    ["five_hour", "5h"],
    ["seven_day", "weekly"],
  ] as const) {
    const w = obj(u[key]);
    const used = num(w?.utilization);
    if (used === undefined) continue;
    if (windows.some((x) => x.scope === ALL_MODELS && x.period === period)) continue;
    windows.push({
      scope: ALL_MODELS,
      period,
      used_percent: round(used),
      resets_at: isoTime(w?.resets_at),
      status: windowStatus(used, t),
    });
  }
  const extra = obj(u.extra_usage);
  return {
    plan: null,
    status: null,
    windows,
    balance: null,
    details: {
      ...(extra && {
        extra_usage: {
          enabled: extra.is_enabled,
          used_credits: extra.used_credits,
          monthly_limit: extra.monthly_limit,
          currency: extra.currency,
          disabled_reason: extra.disabled_reason,
        },
      }),
      ...(Array.isArray(obj(u.seven_day_breakdown)?.rows) && {
        weekly_breakdown: obj(u.seven_day_breakdown)?.rows,
      }),
    },
  };
}

/** `anthropic-ratelimit-unified-*` on every Claude response; undefined when absent. */
export function parseClaudeHeaders(
  headers: Record<string, string>,
  t: Thresholds,
): AccountLimits | undefined {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const get = (name: string) => h[`anthropic-ratelimit-unified-${name}`];
  const overall = get("status");
  if (overall === undefined) return undefined;
  const windows: LimitWindow[] = [];
  for (const [claim, period] of [
    ["5h", "5h"],
    ["7d", "weekly"],
  ] as const) {
    const utilization = num(get(`${claim}-utilization`));
    if (utilization === undefined) continue;
    const used = utilization * 100;
    windows.push({
      scope: ALL_MODELS,
      period,
      used_percent: round(used),
      resets_at: isoTime(get(`${claim}-reset`)),
      status: windowStatus(used, t, CLAUDE_STATUS[get(`${claim}-status`) ?? ""]),
    });
  }
  return {
    plan: null,
    status: CLAUDE_STATUS[overall] ?? null,
    windows,
    balance: null,
    details: {
      binding_claim: get("representative-claim") ?? null,
      overage_status: get("overage-status") ?? null,
      overage_disabled_reason: get("overage-disabled-reason") ?? null,
    },
  };
}

// ── Codex (ChatGPT plans) ─────────────────────────────────────────────────────

function codexWindow(
  w: Record<string, unknown> | undefined,
  minutes: number | undefined,
  limitReached: boolean,
  t: Thresholds,
): LimitWindow | undefined {
  const used = num(w?.used_percent);
  if (!w || used === undefined || !minutes) return undefined;
  return {
    scope: ALL_MODELS,
    period: periodOf(minutes),
    used_percent: round(used),
    resets_at: isoTime(w.reset_at),
    status: windowStatus(used, t, limitReached && used >= 100 ? "exhausted" : undefined),
  };
}

function codexLimits(
  plan: unknown,
  rateLimits: Record<string, unknown> | undefined,
  primary: [Record<string, unknown> | undefined, number | undefined],
  secondary: [Record<string, unknown> | undefined, number | undefined],
  details: Record<string, unknown>,
  t: Thresholds,
): AccountLimits {
  const reached = rateLimits?.limit_reached === true;
  const windows = [
    codexWindow(primary[0], primary[1], reached, t),
    codexWindow(secondary[0], secondary[1], reached, t),
  ].filter((w): w is LimitWindow => w !== undefined);
  return {
    plan: typeof plan === "string" ? plan : null,
    status: reached || rateLimits?.allowed === false ? "exhausted" : null,
    windows,
    balance: null,
    details,
  };
}

const minutesFromSeconds = (w: Record<string, unknown> | undefined) => {
  const secs = num(w?.limit_window_seconds);
  return secs === undefined ? undefined : secs / 60;
};

/** `GET chatgpt.com/backend-api/wham/usage`. */
export function parseCodexUsage(json: unknown, t: Thresholds): AccountLimits {
  const u = obj(json) ?? {};
  const rl = obj(u.rate_limit);
  const primary = obj(rl?.primary_window);
  const secondary = obj(rl?.secondary_window);
  return codexLimits(
    u.plan_type,
    rl,
    [primary, minutesFromSeconds(primary)],
    [secondary, minutesFromSeconds(secondary)],
    {
      credits: u.credits ?? null,
      reset_credits: u.rate_limit_reset_credits ?? null,
      spend_control: u.spend_control ?? null,
      additional_rate_limits: u.additional_rate_limits ?? null,
    },
    t,
  );
}

/** The `codex.rate_limits` stream event (WebSocket, pi-ai's default); undefined otherwise. */
export function parseCodexEvent(data: unknown, t: Thresholds): AccountLimits | undefined {
  const e = obj(data);
  if (e?.type !== "codex.rate_limits") return undefined;
  const rl = obj(e.rate_limits);
  const primary = obj(rl?.primary);
  const secondary = obj(rl?.secondary);
  return codexLimits(
    e.plan_type,
    rl,
    [primary, num(primary?.window_minutes)],
    [secondary, num(secondary?.window_minutes)],
    { credits: e.credits ?? null, additional_rate_limits: e.additional_rate_limits ?? null },
    t,
  );
}

/** `x-codex-*` headers (SSE responses); undefined when absent. */
export function parseCodexHeaders(
  headers: Record<string, string>,
  t: Thresholds,
): AccountLimits | undefined {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (h["x-codex-primary-used-percent"] === undefined) return undefined;
  const side = (name: "primary" | "secondary") =>
    [
      {
        used_percent: h[`x-codex-${name}-used-percent`],
        reset_at: h[`x-codex-${name}-reset-at`],
      },
      num(h[`x-codex-${name}-window-minutes`]),
    ] as [Record<string, unknown>, number | undefined];
  return codexLimits(
    h["x-codex-plan-type"],
    undefined,
    side("primary"),
    side("secondary"),
    { active_limit: h["x-codex-active-limit"] ?? null },
    t,
  );
}

// ── DeepSeek (prepaid) ────────────────────────────────────────────────────────

/** `GET api.deepseek.com/user/balance`. */
export function parseDeepseekBalance(json: unknown, t: Thresholds): AccountLimits {
  const u = obj(json) ?? {};
  const info = Array.isArray(u.balance_infos) ? obj(u.balance_infos[0]) : undefined;
  const amount = num(info?.total_balance);
  const balance =
    amount === undefined ? null : { amount, currency: String(info?.currency ?? "USD") };
  let status: LimitStatus = "ok";
  if (u.is_available === false || (balance && balance.amount <= 0)) status = "exhausted";
  else if (balance && balance.amount < t.warnBalance) status = "warning";
  return {
    plan: "prepaid",
    status,
    windows: [],
    balance,
    details: {
      topped_up_balance: num(info?.topped_up_balance) ?? null,
      granted_balance: num(info?.granted_balance) ?? null,
    },
  };
}
