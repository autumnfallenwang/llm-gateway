import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { APP_DESCRIPTION, APP_NAME, APP_VERSION, LLM_GATEWAY_PORT } from "./config";
import { BackendError } from "./errors";
import { log } from "./lib/logger";
import { chatCompletionRoute } from "./routes/chat";
import { embeddingsRoute } from "./routes/embeddings";
import { modelsRoute } from "./routes/models";
import { validateModelsRoute } from "./routes/validate";
import { ensureAnthropicFresh } from "./services/auth";
import { createCompletion, createStreamingCompletion } from "./services/completion";
import { createEmbedding } from "./services/embeddings";
import { VisionFallbackError } from "./services/image/fallback";
import { ImageLoadError } from "./services/image/load";
import { listModels, resolveModel } from "./services/registry";
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

app.use("/*", cors());

// Request access log: one structured line per request (event="http.request") with
// req_id, method, path, status, latency_ms. Skips the Swagger / openapi / health
// noise to keep logs focused on real API traffic.
const REQUEST_LOG_SKIP = new Set(["/", "/docs", "/openapi.json"]);
app.use("*", async (c, next) => {
  const start = Date.now();
  const reqId = crypto.randomUUID();
  c.set("req_id", reqId);
  await next();
  if (REQUEST_LOG_SKIP.has(c.req.path)) return;
  log.info(
    {
      event: "http.request",
      req_id: reqId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latency_ms: Date.now() - start,
    },
    "request handled",
  );
});

// Chat completions
app.openapi(chatCompletionRoute, async (c) => {
  const body = c.req.valid("json");

  let resolved = resolveModel(body.model);
  if (!resolved) {
    return c.json(
      {
        error: {
          message: `Model '${body.model}' not found`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      },
      404,
    );
  }

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
    const refreshed = resolveModel(body.model);
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
                param: null,
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
            param: null,
            code: err.errorCode,
          },
        },
        err.httpStatus as 400 | 429 | 500,
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

  const resolved = resolveModel(body.model);
  if (!resolved) {
    return c.json(
      {
        error: {
          message: `Model '${body.model}' not found`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      },
      404,
    );
  }

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
            param: null,
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
      validated_at: report.validatedAt,
      ...(result.embeddingDim !== undefined && { embedding_dimensions: result.embeddingDim }),
    };
  });
  return c.json({ object: "list" as const, data: enriched }, 200);
});

// Model validation
app.openapi(validateModelsRoute, async (c) => {
  try {
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
    { url: `http://localhost:${LLM_GATEWAY_PORT}`, description: "Local development server" },
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
app.get("/", (c) => c.json({ status: "ok", name: APP_NAME, version: APP_VERSION }));

export default app;
