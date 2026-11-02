# Usage limits endpoint (Phase 13)

Let apps — a chatbot, first — show how much of each paid family's allowance is left for the model in use, before and after each message. Planned from live POCs and built 2026-11-02 (branch `feat/usage-limits`); it builds on Phase 12's model IDs ([model-ids.md](model-ids.md)).

## Findings (POCs, 2026-11-02)

All three paid families expose it; none has a documented "remaining" API except DeepSeek's balance. The POCs went through `src/lib/pi.ts`, so the gateway can capture the same data. pi-ai has the plumbing — `onResponse` (HTTP headers) and `onProviderStreamEvent` (raw stream events), plus per-request `usage.cost` — but no limits feature; its only limit handling turns a Codex "limit reached" error into "try again in ~N min".

**Sources.** *Response* = free with every request (header or stream event). *Endpoint* = on demand, costs no tokens. Fields marked † are known to the official client but weren't sent to this account.

### Claude (subscription; this account is Ultra, formerly Max 20x)

On 2026-10-30 Anthropic renamed Max 20x to **Ultra** and dropped its **5-hour limit for verified accounts**; Ultra has a weekly all-models limit plus a separate weekly Fable limit. Max (formerly Max 5x) and unverified Ultra accounts keep the 5-hour window. So windows must be read, never assumed.

| Field | Meaning | Source | Seen |
|---|---|---|---|
| `anthropic-ratelimit-unified-status` | `allowed` / `allowed_warning` / `rejected` | Response header | `allowed` |
| `…-representative-claim` | The binding window | Response header | `seven_day` |
| `…-reset` | Binding window's reset (epoch s) | Response header | 2026-11-06 10:00 UTC |
| `…-7d-utilization` / `-7d-reset` / `-7d-status` | Weekly all-models window (0–1) | Response header; endpoint `seven_day` (0–100) | 0.42 / 43 |
| `…-5h-utilization` / `-5h-reset` / `-5h-status` † | 5-hour window | Response header; endpoint `five_hour` | — / `null` |
| `…-overage-status` / `-overage-disabled-reason` | Paid credits past the plan limit | Response header; endpoint `extra_usage`, `spend` | `rejected` / `out_of_credits` |
| `…-surpassed-threshold`, `-slow-*`, `-grace-*`, `-upgrade-paths`, `-fallback-percentage` † | Warnings, slow mode, grace, upsell (by name) | Response header | — |
| `limits[]` | Each active limit: `kind`, `percent`, `severity`, `resets_at`, `scope.model` | Endpoint | `weekly_all` 43%, `weekly_scoped` Fable 4% |
| `seven_day_breakdown.rows` | This week's share by surface | Endpoint | Claude Code 100% |

Endpoint: `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token and `anthropic-beta: oauth-2025-04-20` (undocumented; what the official clients use). The Fable scoped limit appears only here, not in headers.

### GPT / Codex (ChatGPT Go)

Go has **one 30-day window** (the client calls it the "monthly usage limit"); Plus and Pro have a 5-hour primary and a weekly secondary. Over SSE the data is in headers; over WebSocket — pi-ai's default, so the gateway's path — only in the `codex.rate_limits` stream event.

| Field | Meaning | Source | Seen |
|---|---|---|---|
| plan | Account plan | `x-codex-plan-type`; event/endpoint `plan_type` | `go` |
| primary window | `used_percent` (integer), length, `reset_at`, `reset_after_seconds` | `x-codex-primary-*`; event `rate_limits.primary`; endpoint `primary_window` | 0%, 43200 min, 2026-12-02 03:55 UTC |
| secondary window | Same, second window | `x-codex-secondary-*`; `secondary`; `secondary_window` | none |
| `allowed` / `limit_reached` | Can requests go through now | Event; endpoint | true / false |
| credits | Purchased credits | `x-codex-credits-*`; `credits` | none |
| `rate_limit_reset_credits` | Banked resets (available / usable now) | Endpoint | 3 / 0 |
| `spend_control`, `additional_rate_limits`, `code_review_rate_limit` | Spending cap; per-model limits (likely); code review | Endpoint | — |
| limit hit | 429 `usage_limit_reached` + `resets_at` | Error | — |

Endpoint: `GET https://chatgpt.com/backend-api/wham/usage` with the token and `chatgpt-account-id` (undocumented). `used_percent` is a whole number and OpenAI doesn't publish Go's allowance size, so "0%" means under 1% and there's no absolute "N left".

### DeepSeek (prepaid)

No rate limits and no limit headers. Money is the limit.

| Field | Meaning | Source | Seen |
|---|---|---|---|
| `is_available`, `total_balance`, `topped_up_balance`, `granted_balance`, `currency` | Money left | Endpoint `GET /user/balance` (documented) | $9.96, all topped up |
| `usage` (`prompt_cache_hit_tokens` / `_miss_tokens`, `reasoning_tokens`) | Tokens per request; cache hits cost 50× less | Response body | — |
| `usage.cost` | Actual spend per request, from catalog prices | pi-ai | $0.0000069 |
| 402 "Insufficient Balance" | Out of money (the gateway returns 429 `insufficient_quota`) | Error | — |

DeepSeek's own default is thinking **on** (a raw request used 12 reasoning tokens); the gateway's default is off.

## Design

### One format, every family

Core fields mean the same thing everywhere; family-only extras go in `details`.

```json
GET /v1/limits?model=<id>          (no model → every family)
{
  "model": "claude-fable-5-1", "provider": "anthropic", "plan": "ultra",
  "status": "ok",                                   // ok | warning | exhausted | unknown
  "available": { "kind": "percent", "percent_left": 57,
                 "resets_at": "2026-11-06T10:00:00Z", "binding": "weekly · all models" },
  "windows": [
    { "scope": "all models", "period": "weekly", "used_percent": 43, "resets_at": "…", "status": "ok" },
    { "scope": "Fable",      "period": "weekly", "used_percent": 4,  "resets_at": "…", "status": "ok" }
  ],
  "balance": null,                                  // { "amount": 9.96, "currency": "USD" } for DeepSeek
  "details": { },                                   // family-specific, raw, not guaranteed stable
  "as_of": "2026-11-02T07:06:13Z", "source": "response"
}
```

`model` takes either ID form (Phase 12) — a query parameter, since qualified IDs contain `/` and Ollama IDs `:`.

### Per model, not per family

Which windows apply depends on the model: `claude-sonnet-5-5` → weekly all-models; `claude-fable-5-1` → that **and** the Fable window (whichever is closer to running out binds); `gpt-6-luna` → the monthly window (`additional_rate_limits` may add per-model ones); `deepseek-*` → the balance. The gateway owns that mapping.

### One store, two feeds

A limits store per provider account, keyed by (provider, model) — never the bare ID:

- **Free, from traffic:** the Claude headers and the Codex `codex.rate_limits` event, captured through pi-ai's hooks in `pi.ts`.
- **Complete, on demand:** the three endpoints, fetched when the cached data is older than ~60 s.
- **Chat never depends on it.** If an endpoint fails or changes, the store serves the last good data with its `as_of`, and `status: "unknown"` once that's too old.

**Account-wide, not the gateway's share.** Claude's 43% includes the owner's own Claude Code use. Apps can show "57% of this week's allowance left", not who spent it.

## As built

- **Code:** `src/services/limits/parse.ts` (pure parsers, one per source) and `src/services/limits/index.ts` (the store, the endpoint fetchers, the per-model views); `GET /v1/limits` in `src/routes/limits.ts`. Completions for Claude and Codex pass pi-ai's `onResponse` (and, for Codex, `onProviderStreamEvent`) hooks, which feed the store.
- **Merging:** the endpoint's data is the base; a newer response's windows replace the matching (scope, period) ones and its verdict wins, while windows only the endpoint knows (Claude's Fable-scoped one) are kept. `source` says which was newest.
- **Without `?model=`:** one entry per registered family, account-wide — every window listed, `available` bound by the account-wide ones only. Ollama is `{ "kind": "unlimited" }`, with no fetch.
- **Claude's `plan` is null:** none of its sources name the plan.
- **Logging:** every completion logs `completion.usage` — tokens, `cost_usd` (pi-ai's, from catalog prices; for subscriptions an API-price equivalent), and, from the cache without fetching, `limit_status`, `limit_percent_left` and `limit_window` (or `balance_left`).
- **The endpoints are called with the gateway's own credentials**: its own Claude chain (refreshed first if due), the host Codex login (`originator: pi`, as pi-ai sends), the DeepSeek key.

## Work

| # | Task | Status |
|---|---|---|
| 71 | Store + parsers per family (from POC fixtures), fed by pi.ts hooks and the three endpoints | ✅ |
| 72 | Per-model window mapping and the binding window | ✅ |
| 73 | `GET /v1/limits[?model=]` with its OpenAPI schema | ✅ |
| 74 | Per-request logging: `completion.usage` with tokens, `cost_usd`, the binding window | ✅ |
| 75 | Optional: a `limits` summary per model in `/v1/models` | not done — add if a model picker needs it |
| 76 | Tests: 30 unit (parsers on the POC fixtures, store, views, route, hooks) + `npm run test:limits-poc` 5/5 live | ✅ |

## Decided (were open questions)

- **Cache:** an endpoint result is reused for `LIMITS_CACHE_MS` (60 s); concurrent callers share one fetch.
- **Warning:** at or above `LIMITS_WARN_PERCENT` (80) used, or when the provider says so (Claude's `allowed_warning`, a `limits[].severity` other than `normal`); a balance below `LIMITS_WARN_BALANCE` (1.00). 100% used, Claude's `rejected`, Codex's `limit_reached` or an empty balance is `exhausted`.
- **Stale:** when the endpoint keeps failing, the last good data is served with its `as_of` and `details.last_error`; once older than `LIMITS_STALE_MS` (10 min) the status is `unknown`.

## Later

Limits on each chat response (if polling after each reply isn't enough); steering or fallback near a limit; per-app accounting (tokens and `usage.cost` per caller).
