import { createRoute } from "@hono/zod-openapi";
import { ErrorResponseSchema } from "../schemas/error";
import { ValidateResponseSchema } from "../schemas/validate";

export const validateModelsRoute = createRoute({
  method: "post",
  path: "/v1/models/validate",
  operationId: "validateModels",
  summary: "Validate all registered models",
  description:
    "Reloads the model registry (picking up newly available models, e.g. an `ollama pull` since startup), then sends a test prompt to every registered model and records whether it responds successfully. Results are cached and used to filter the GET /v1/models response.",
  tags: ["Models"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ValidateResponseSchema,
        },
      },
      description: "Validation results for all registered models",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Validation process failed",
    },
  },
});
