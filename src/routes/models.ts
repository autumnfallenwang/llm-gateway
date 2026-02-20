import { createRoute } from "@hono/zod-openapi";
import { ModelsResponseSchema } from "../schemas/models";

export const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  operationId: "listModels",
  summary: "List available models",
  description:
    "Returns models from all configured backends (Ollama, Anthropic, Codex). Each model includes `context_window` and `max_tokens` fields. After validation, only models that passed health checks are returned.",
  tags: ["Models"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ModelsResponseSchema,
        },
      },
      description: "List of available models",
    },
  },
});
