import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { APP_DESCRIPTION, APP_NAME, APP_VERSION, LLM_GATEWAY_PORT } from "./config";
import { chatCompletionRoute } from "./routes/chat";
import { modelsRoute } from "./routes/models";
import { validateModelsRoute } from "./routes/validate";
import { createCompletion, createStreamingCompletion } from "./services/completion";
import { VisionFallbackError } from "./services/image/fallback";
import { ImageLoadError } from "./services/image/load";
import { listModels, resolveModel } from "./services/registry";
import { readValidationReport, validateAllModels } from "./services/validation";

const app = new OpenAPIHono({
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

// Chat completions
app.openapi(chatCompletionRoute, async (c) => {
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

  if (!report) {
    return c.json({ object: "list" as const, data: allModels }, 200);
  }

  const filtered = allModels.filter((m) => report.models[m.id]?.status === "ok");
  return c.json({ object: "list" as const, data: filtered }, 200);
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
    { name: "Models", description: "Model listing and validation" },
  ],
});

// Swagger UI
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// Health check
app.get("/", (c) => c.json({ status: "ok", name: APP_NAME, version: APP_VERSION }));

export default app;
