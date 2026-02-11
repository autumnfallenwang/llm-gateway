import { createRoute } from "@hono/zod-openapi";
import { ErrorResponseSchema } from "../schemas/error";
import { ValidateResponseSchema } from "../schemas/validate";

export const validateModelsRoute = createRoute({
  method: "post",
  path: "/v1/models/validate",
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
