import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { chatCompletionRoute } from "./routes/chat";
import { modelsRoute } from "./routes/models";
import { validateModelsRoute } from "./routes/validate";
import { createCompletion } from "./services/completion";
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

  if (body.stream) {
    return c.json(
      {
        error: {
          message: "Streaming is not supported yet",
          type: "invalid_request_error",
          param: "stream",
          code: null,
        },
      },
      400,
    );
  }

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
    const response = await createCompletion(resolved, body);
    return c.json(response, 200);
  } catch (err) {
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
    version: "0.1.0",
    description: "Self-hosted OpenAI-compatible API gateway for multiple LLM backends",
  },
});

// Swagger UI
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// Health check
app.get("/", (c) => c.json({ status: "ok", name: "llm-gateway", version: "0.1.0" }));

export default app;
