import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import {
  APP_COMMIT,
  APP_DESCRIPTION,
  APP_NAME,
  APP_VERSION,
  LLM_GATEWAY_PORT,
  LLMGW_ALLOWED_HOSTS,
} from "./config";
import { BackendError } from "./errors";
import { log, requestContext } from "./lib/logger";
import { requestGuard } from "./lib/request-guard";
import { chatCompletionRoute } from "./routes/chat";
import { embeddingsRoute } from "./routes/embeddings";
import { limitsRoute } from "./routes/limits";
import { modelsRoute } from "./routes/models";
import { validateModelsRoute } from "./routes/validate";
import { ensureAnthropicFresh, ensureHostCredentialsFresh } from "./services/auth";
import { createCompletion, createStreamingCompletion } from "./services/completion";
import { createEmbedding } from "./services/embeddings";
import { VisionFallbackError } from "./services/image/fallback";
import { ImageLoadError } from "./services/image/load";
import { allLimits, limitsFor } from "./services/limits/index";
import { listModels, loadRegistry, lookupModel, resolveModel } from "./services/registry";
import { readValidationReport, validateAllModels } from "./services/validation";

type AppVariables = { req_id: string };

// biome-ignore lint/style/useNamingConvention: Variables is Hono's required generic key
const app = new OpenAPIHono<{ Variables: AppVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const param = firstIssue?.path?.join(".") || null;
      return c.json(
        {
          error: {
            message: firstIssue?.message ?? "Validation error",
            type: "invalid_request_error",
            param,
            code: null,
          },
        },
        400,
      );
    }
  },
});

// Request access log: one structured line per request (event="http.request") with
// req_id, method, path, status, latency_ms. Skips the Swagger / openapi / health
// noise to keep logs focused on real API traffic. The request runs inside
// requestContext, so every line logged while it's handled carries the same req_id.
// As in mcpgw: the caller's X-Request-Id is logged as request_id, and the gateway's
// own req_id goes back in the X-Request-Id response header.
const REQUEST_LOG_SKIP = new Set(["/", "/docs", "/openapi.json"]);
/** A caller's value reaches the logs only if it looks like an ID, never as free text. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
app.use("*", async (c, next) => {
  const start = Date.now();
  const reqId = crypto.randomUUID();
  const incoming = c.req.header("x-request-id");
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : undefined;
  c.set("req_id", reqId);
  await requestContext.run({ req_id: reqId, ...(requestId && { request_id: requestId }) }, next);
  // After next(): a stream's Response is made by its handler, so a header set before wouldn't reach it.
  c.res.headers.set("X-Request-Id", reqId);
  if (REQUEST_LOG_SKIP.has(c.req.path)) return;
  log.info(
    {
      event: "http.request",
      req_id: reqId,
      ...(requestId && { request_id: requestId }),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latency_ms: Date.now() - start,
    },
    "request handled",
  );
});

// After the request log, so a refusal shows up there too.
app.use("*", requestGuard(LLMGW_ALLOWED_HOSTS));

function modelNotFound(model: string) {
  return {
    error: {
      message: `Model '${model}' not found`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  };
}

/** A bare model ID that several providers list: name one as provider/model. */
function ambiguousModel(model: string, choices: string[]) {
  return {
    error: {
      message: `Model '${model}' is listed by more than one provider; use one of: ${choices.join(", ")}`,
      type: "invalid_request_error",
      param: "model",
      code: "ambiguous_model",
    },
  };
}

// Chat completions
app.openapi(chatCompletionRoute, async (c) => {
  const body = c.req.valid("json");

  const lookup = lookupModel(body.model);
  if (lookup.kind === "ambiguous") return c.json(ambiguousModel(body.model, lookup.choices), 400);
  if (lookup.kind === "missing") return c.json(modelNotFound(body.model), 404);
  let resolved = lookup.resolved;

  // Capability gate: embedding-only models would 5xx upstream when called via chat.
  // Mirror of the gate in createEmbedding(); see openai-embeddings-spec.md.
  if (resolved.capability === "embedding") {
    return c.json(
      {
        error: {
          message: `Model '${body.model}' is an embedding model. Use POST /v1/embeddings instead.`,
          type: "invalid_request_error",
          param: "model",
          code: "wrong_capability",
        },
      },
      400,
    );
  }

  // Lazy refresh: Anthropic OAuth tokens live ~45 min and the container maintains its own
  // refresh chain. Refresh on the request path (single-flight via a mutex inside auth.ts)
  // and re-resolve so the resolved model carries the fresh access token.
  if (resolved.provider === "anthropic") {
    try {
      await ensureAnthropicFresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Anthropic credential refresh failed";
      return c.json(
        {
          error: {
            message: `Anthropic auth error: ${message}`,
            type: "server_error",
            param: null,
            code: "anthropic_auth_failed",
          },
        },
        500,
      );
    }
    const refreshed = resolveModel(resolved.id);
    if (refreshed) resolved = refreshed;
  }
  // Codex and DeepSeek read host files (the Codex login, the DeepSeek key): pick up a change.
  if (resolved.provider === "codex" || resolved.provider === "deepseek") {
    await ensureHostCredentialsFresh(resolved.provider);
    const refreshed = resolveModel(resolved.id);
    if (refreshed) resolved = refreshed;
  }

  if (body.stream) {
    return streamSSE(c, async (sseStream) => {
      try {
        for await (const data of createStreamingCompletion(resolved, body)) {
          await sseStream.writeSSE({ data });
        }
        await sseStream.writeSSE({ data: "[DONE]" });
      } catch (err) {
        if (err instanceof ImageLoadError) {
          await sseStream.writeSSE({
            data: JSON.stringify({
              error: {
                message: err.message,
                type: "invalid_request_error",
                param: "messages",
                code: null,
              },
            }),
          });
          return;
        }
        if (err instanceof VisionFallbackError) {
          await sseStream.writeSSE({
            data: JSON.stringify({
              error: {
                message: err.message,
                type: "server_error",
                param: null,
                code: "vision_fallback_failed",
              },
            }),
          });
          return;
        }
        if (err instanceof BackendError) {
          await sseStream.writeSSE({
            data: JSON.stringify({
              error: {
                message: err.message,
                type: err.errorType,
                param: err.param,
                code: err.errorCode,
              },
            }),
          });
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown backend error";
        await sseStream.writeSSE({
          data: JSON.stringify({
            error: {
              message: `Backend error: ${message}`,
              type: "server_error",
              param: null,
              code: null,
            },
          }),
        });
      }
    });
  }

  try {
    const response = await createCompletion(resolved, body);
    return c.json(response, 200);
  } catch (err) {
    if (err instanceof ImageLoadError) {
      return c.json(
        {
          error: {
            message: err.message,
            type: "invalid_request_error",
            param: "messages",
            code: null,
          },
        },
        400,
      );
    }
    if (err instanceof VisionFallbackError) {
      return c.json(
        {
          error: {
            message: err.message,
            type: "server_error",
            param: null,
            code: "vision_fallback_failed",
          },
        },
        502,
      );
    }
    if (err instanceof BackendError) {
      return c.json(
        {
          error: {
            message: err.message,
            type: err.errorType,
            param: err.param,
            code: err.errorCode,
          },
        },
        err.httpStatus as 400 | 404 | 429 | 500,
      );
    }
    const message = err instanceof Error ? err.message : "Unknown backend error";
    return c.json(
      {
        error: {
          message: `Backend error: ${message}`,
          type: "server_error",
          param: null,
          code: null,
        },
      },
      500,
    );
  }
});

// Embeddings
app.openapi(embeddingsRoute, async (c) => {
  const body = c.req.valid("json");

  const lookup = lookupModel(body.model);
  if (lookup.kind === "ambiguous") return c.json(ambiguousModel(body.model, lookup.choices), 400);
  if (lookup.kind === "missing") return c.json(modelNotFound(body.model), 404);
  const resolved = lookup.resolved;

  try {
    const response = await createEmbedding(resolved, body);
    return c.json(response, 200);
  } catch (err) {
    if (err instanceof BackendError) {
      return c.json(
        {
          error: {
            message: err.message,
            type: err.errorType,
            param: err.param,
            code: err.errorCode,
          },
        },
        err.httpStatus as 400 | 404 | 429 | 500 | 501,
      );
    }
    const message = err instanceof Error ? err.message : "Unknown backend error";
    return c.json(
      {
        error: {
          message: `Backend error: ${message}`,
          type: "server_error",
          param: null,
          code: null,
        },
      },
      500,
    );
  }
});

// Models list
app.openapi(modelsRoute, async (c) => {
  const allModels = listModels();
  const report = await readValidationReport();

  const enriched = allModels.map((m) => {
    if (!report) {
      return { ...m, status: "unknown" as const, status_detail: null, validated_at: null };
    }
    const result = report.models[m.id];
    if (!result) {
      return {
        ...m,
        status: "unknown" as const,
        status_detail: null,
        validated_at: report.validatedAt,
      };
    }
    return {
      ...m,
      status: result.status,
      status_detail: result.error ?? null,
      validated_at: result.validatedAt ?? report.validatedAt,
      ...(result.embeddingDim !== undefined && { embedding_dimensions: result.embeddingDim }),
    };
  });
  return c.json({ object: "list" as const, data: enriched }, 200);
});

// Usage limits (docs/usage-limits.md)
app.openapi(limitsRoute, async (c) => {
  const { model } = c.req.valid("query");
  if (!model) return c.json({ object: "list" as const, data: await allLimits() }, 200);
  const lookup = lookupModel(model);
  if (lookup.kind === "ambiguous") return c.json(ambiguousModel(model, lookup.choices), 400);
  if (lookup.kind === "missing") return c.json(modelNotFound(model), 404);
  // A model whose last check failed (not on the plan, say) is unavailable, as /v1/models says.
  const check = (await readValidationReport())?.models[lookup.resolved.id];
  return c.json(await limitsFor(lookup.resolved, check), 200);
});

// Model validation
app.openapi(validateModelsRoute, async (c) => {
  try {
    // Reload the registry first so a validate run also picks up models that became
    // available since boot — e.g. an `ollama pull`, or new provider model IDs after a
    // pi-ai bump. The registry is otherwise only built at startup. Non-fatal: if the
    // reload hiccups (e.g. Ollama briefly unreachable) we still validate the current set.
    try {
      // A Codex login or DeepSeek key that appeared or changed since boot registers too.
      await ensureHostCredentialsFresh();
      await loadRegistry();
    } catch (err) {
      log.warn(
        { event: "validation.registry_reload_failed", err },
        "Registry reload before validation failed — validating the currently-loaded models",
      );
    }
    const report = await validateAllModels();
    return c.json(report, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Validation failed";
    return c.json(
      {
        error: {
          message: `Validation error: ${message}`,
          type: "server_error",
          param: null,
          code: null,
        },
      },
      500,
    );
  }
});

// OpenAPI spec
app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "LLM Gateway",
    version: APP_VERSION,
    description: APP_DESCRIPTION,
  },
  servers: [
    {
      url: "http://llmgw.llmgw.svc.cluster.local",
      description: "Cluster (from a pod, or from arch)",
    },
    { url: `http://localhost:${LLM_GATEWAY_PORT}`, description: "Local dev (npm run dev)" },
  ],
  tags: [
    { name: "Chat", description: "Chat completion endpoints" },
    { name: "Embeddings", description: "Embedding endpoints" },
    { name: "Models", description: "Model listing and validation" },
  ],
});

// Swagger UI
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// Health check
app.get("/", (c) =>
  c.json({ status: "ok", name: APP_NAME, version: APP_VERSION, commit: APP_COMMIT }),
);

export default app;
