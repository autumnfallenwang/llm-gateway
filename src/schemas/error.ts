import { z } from "@hono/zod-openapi";

export const ErrorResponseSchema = z.object({
  error: z.object({
    message: z.string().openapi({ description: "Human-readable error description" }),
    type: z.string().openapi({
      description:
        "Error category: 'invalid_request_error', 'rate_limit_exceeded', or 'server_error'",
    }),
    param: z
      .string()
      .nullable()
      .openapi({ description: "Request parameter that caused the error, if applicable" }),
    code: z.string().nullable().openapi({
      description:
        "Machine-readable error code: 'model_not_found', 'context_length_exceeded', 'rate_limit_exceeded', 'vision_fallback_failed', 'server_error', or null for validation errors",
    }),
  }),
});
