import { createRoute } from "@hono/zod-openapi";
import { ModelsResponseSchema } from "../schemas/models";

export const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
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
