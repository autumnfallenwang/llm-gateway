import { z } from "@hono/zod-openapi";

export const ErrorResponseSchema = z.object({
  error: z.object({
    message: z.string().openapi({ description: "Human-readable error description" }),
    type: z
      .string()
      .openapi({ description: "Error category: 'invalid_request_error' or 'server_error'" }),
    param: z
      .string()
      .nullable()
      .openapi({ description: "Request parameter that caused the error, if applicable" }),
    code: z
      .string()
      .nullable()
      .openapi({ description: "Machine-readable error code, if applicable" }),
  }),
});
