# Structured Logging Specification

The contract for log output from llm-gateway. Pinned here so the design is locked before the 29 existing `console.*` call sites get migrated.

## TL;DR

- **One JSON object per line, written to stdout.** Container catches stdout; we never write log files from app code.
- **Library: `pino`.** Modern Node default, fast (~3× alternatives), structured by design.
- **Universal shape** that every major log system (Loki, ELK, Datadog, Splunk, CloudWatch) ingests without re-mapping.
- **Migration: 29 `console.log/warn/error` sites** convert to typed `log.info/warn/error` calls with structured fields.
- **One new middleware** for per-request access logs (currently we have zero request-level observability).
- **Out of scope**: file output, rotation, transports, alerting, log shipping. Those are the platform's job (Promtail tails Docker's stdout capture; Loki stores; Grafana queries — none of which the app needs to know about).

## Goals

1. **Queryable history.** Every event is a JSON object with named fields, so we can answer "did X fail?" by filtering, not greping.
2. **Universal format.** Output works against Loki today, ELK or Datadog tomorrow, with no app-side change.
3. **Per-request access logs.** Currently invisible — we don't even log that a request happened. New Hono middleware fixes this.
4. **Tier of detail via levels.** Quiet by default in prod (`info`); `LOG_LEVEL=debug` for deep dives without redeployment.
5. **No new ops surface.** Stays "console + Docker + `llmgw logs`" — Loki/Promtail layer on top via Docker's existing log capture, not via app changes.

## Non-goals

- File output, rotation, retention — Docker handles capture, Promtail handles forwarding.
- HTTP/Slack/email transports — ship via Loki, alert via Grafana.
- OpenTelemetry adoption — overkill for one app, can be added later if multi-service tracing matters.
- Per-app log dashboards — that's Phase B (metrics + Prometheus), separate concern.

## The log line shape

Every line is a single JSON object with a fixed core and free-form contextual fields:

### Required fields (emitted on every line)

| Field | Type | Source | Example |
|---|---|---|---|
| `time` | string | pino default | `"2026-05-07T04:53:04.301Z"` (ISO 8601 UTC) |
| `level` | string | pino default | `"info"` / `"warn"` / `"error"` / `"debug"` / `"fatal"` |
| `msg` | string | passed to logger | `"Anthropic token refreshed"` |
| `service` | string | base config | `"llm-gateway"` |
| `version` | string | base config | `"0.3.2"` |

### Optional but conventionalized fields

| Field | Type | When | Example |
|---|---|---|---|
| `event` | string | always when there's a categorical event | `"auth.refresh"`, `"http.request"` |
| `req_id` | string | inside request handlers | UUID per request |
| `err` | object | when an Error is involved | `{type, message, stack}` (pino auto-formats) |
| any domain field | any | freely | `model: "bge-m3:latest"`, `latency_ms: 103` |

### Example lines

```json
{"time":"2026-05-07T04:53:04.301Z","level":"info","service":"llm-gateway","version":"0.3.2","event":"server.start","port":51277,"msg":"LLM Gateway starting"}
{"time":"2026-05-07T04:53:04.412Z","level":"info","service":"llm-gateway","version":"0.3.2","event":"auth.loaded","provider":"anthropic","source":"cache","msg":"Anthropic credentials loaded from cache"}
{"time":"2026-05-07T04:53:05.013Z","level":"info","service":"llm-gateway","version":"0.3.2","event":"http.request","req_id":"a1b2c3","method":"POST","path":"/v1/embeddings","status":200,"latency_ms":103,"msg":"request handled"}
{"time":"2026-05-07T04:53:05.234Z","level":"error","service":"llm-gateway","version":"0.3.2","event":"auth.refresh.failed","provider":"anthropic","err":{"type":"Error","message":"upstream 502","stack":"..."},"msg":"Anthropic refresh failed"}
```

## Field naming conventions

- **`event`**: dotted lowercase, namespace.action — `auth.refresh`, `http.request`, `validation.completed`, `embedding.failed`. Each top-level namespace = a subsystem.
- **`*_ms`**: durations in milliseconds, always.
- **`*_count`**: integer counts.
- **`status`**: HTTP status code, integer.
- **`err`**: reserved for Error objects; pino auto-serializes `{type, message, stack}`.
- **Don't embed dynamic values in `msg`.** `msg` is human-readable boilerplate; the dynamic part goes in fields.
  - ✅ `log.info({ model: "bge-m3", dim: 1024 }, "Embedding succeeded")`
  - ❌ `log.info(\`Embedding bge-m3 succeeded with dim 1024\`)`

## Level taxonomy

| Level | When to use |
|---|---|
| `fatal` | About to crash the process. Rare. |
| `error` | An operation failed in a way the user/operator cares about. Returns 5xx, refresh failed, etc. |
| `warn` | Recoverable abnormal condition. Stale credentials, missing optional config, hit fallback. |
| `info` | Normal operational events. Server started, request handled, validation completed. **Production default.** |
| `debug` | Detailed diagnostic info, only useful when troubleshooting. Off by default. |
| `trace` | Pino has it; we don't use it. |

Production: `LOG_LEVEL=info`. Troubleshooting: bump to `debug` via env var, no redeploy needed.

## Library choice: `pino`

Picked over alternatives:

| | pino | winston | bunyan |
|---|---|---|---|
| Speed | ~3× faster | slow | medium |
| Structured by default | ✅ | ⚠️ (configure) | ✅ |
| Active maintenance | ✅ | ✅ | ❌ |
| Transports we don't need | minimal | many built-in | minimal |
| Hono integration | first-class | works | works |
| `pino-pretty` for dev | ✅ | needs custom | ❌ |

`pino` is also the default logger in NestJS and the recommended choice in Hono's docs. Boring correct choice.

### Module layout

Single export from `src/lib/logger.ts`:

```ts
import { pino } from "pino";
import { APP_NAME, APP_VERSION } from "../config.js";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: APP_NAME, version: APP_VERSION },
  timestamp: pino.stdTimeFunctions.isoTime,
});
```

Imported as `import { log } from "./lib/logger.js"` everywhere we currently use `console.*`.

For dev, run `npm run dev | npx pino-pretty` to get human-readable output. JSON in prod (the container) stays as-is for Promtail.

## Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `"info"` | Minimum level to emit. Set to `"debug"` for verbose troubleshooting. |

That's it. No log paths, no transport URLs, no rotation policy — those are platform concerns.

## Migration mapping

The 29 existing `console.log/warn/error` sites translate cleanly. Pattern catalog:

### Pattern 1: Bracketed namespace strings → `event` field

```ts
// before
console.log("[auth] Anthropic credentials loaded from cache");

// after
log.info({ event: "auth.credentials.loaded", provider: "anthropic", source: "cache" }, "Anthropic credentials loaded from cache");
```

### Pattern 2: Template strings with dynamic values → fields

```ts
// before
console.log(`[validation] ${m.id}: ${result.status} (${result.latencyMs}ms)`);

// after
log.info({
  event: "validation.completed",
  model: m.id,
  status: result.status,
  latency_ms: result.latencyMs,
}, "model validation completed");
```

### Pattern 3: Error logs with caught exceptions → `err` field

```ts
// before
console.warn(`[auth] Failed to read Anthropic file ${path}: ${(err as Error).message}`);

// after
log.error({ event: "auth.file.read_failed", path, err }, "Failed to read Anthropic file");
```

`pino` auto-serializes `err` as `{type, message, stack}` when you pass an Error object.

### Inventory of call sites

| Subsystem | Files | Approx count | Suggested `event` namespace |
|---|---|---|---|
| Server startup | `src/index.ts` | 2 | `server.*` |
| Auth | `src/services/auth.ts` | ~12 | `auth.*` |
| Registry | `src/services/registry.ts`, `src/lib/ollama.ts` | ~3 | `registry.*`, `ollama.*` |
| Validation | `src/services/validation.ts` | ~4 | `validation.*` |
| Vision fallback | `src/services/image/fallback.ts` | ~2 | `vision_fallback.*` |
| Other | various | ~6 | per-subsystem |

## Hono request middleware (new)

Currently we have zero request-level observability. This middleware is the highest-value single addition:

```ts
// src/app.ts (after the OpenAPIHono setup, before route registrations)
app.use("*", async (c, next) => {
  const start = Date.now();
  const req_id = crypto.randomUUID();
  c.set("req_id", req_id);
  await next();
  log.info({
    event: "http.request",
    req_id,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latency_ms: Date.now() - start,
  }, "request handled");
});
```

Result: one JSON line per HTTP request, queryable by path/status/latency in Loki. The `req_id` is also available to handlers (`c.get("req_id")`) so any per-request logs they emit can carry the same ID for trace stitching.

## Docker compose log size cap

Right now `docker inspect` shows `LogConfig.Config: {}` — meaning unbounded log growth on the host. Add to `deploy/compose.yaml`:

```yaml
services:
  llm-gateway:
    # ...existing fields...
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

50MB total cap (5 × 10MB rotated files). Promtail tails all of them, so no log loss to Loki side. Without this, an idle gateway with verbose debug logs could fill `/var/lib/docker/` over months.

## What we don't implement

- **No file output from the app.** Docker writes the JSON-file capture; we don't.
- **No log rotation logic in app.** Docker handles it via the size cap above.
- **No HTTP/Slack/email transports.** Promtail ships to Loki; alerting is Grafana's job (later).
- **No request body logging by default.** Bodies can contain prompts/PII; logging them is opt-in via `LOG_LEVEL=debug` only, and only for the request middleware (handler-level body logs stay out of scope).
- **No correlation IDs from upstream.** `req_id` is generated server-side per-request. No `X-Request-Id` header propagation yet.
- **No metrics.** That's Prometheus territory; separate phase if/when we build dashboards.

## Testing

- Unit test the logger module imports and emits the expected base fields.
- Hono middleware test: dispatch a fake request, capture stdout (or use pino's `destination` option to write to a buffer), assert one `http.request` line came out with the right shape.
- Don't test every migrated `console.*` site — they're plumbing. Trust the type system.
- E2E unaffected — assertions are on response codes/bodies, not log output.

## Verification (post-deploy)

```bash
# 1. Container emits structured JSON
llmgw logs | head -5
# expect: lines parseable as JSON, each with time/level/msg/service/version

# 2. Levels respect LOG_LEVEL
docker exec llm-gateway sh -c 'env | grep LOG_LEVEL'
# (expect default 'info' or whatever compose.yaml sets)

# 3. Per-request log shows up
curl -X POST http://localhost:51277/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:30b","messages":[{"role":"user","content":"ping"}],"max_tokens":4}'
llmgw logs | tail -3
# expect: one line with event=http.request, status=200, latency_ms=...

# 4. Once Loki is deployed (separate plan):
curl -G -s 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={container="llm-gateway"} | json | event="http.request"'
```

## Open question deferred

**Container's stdout right now also carries pi-ai's own logs** (e.g., the model-deprecation warning we saw during e2e tests). Those are plain strings, not JSON. They'll show up in Loki as un-parsed lines — Promtail will still ingest them, just without structured fields. Acceptable for now; if it becomes noisy, we can suppress pi-ai's console output via its config or add a JSON wrapper. Defer until we observe real noise.
