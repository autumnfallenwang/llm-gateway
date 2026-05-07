import { z } from "@hono/zod-openapi";

export const ModelValidationResultSchema = z.object({
  status: z
    .enum(["ok", "error"])
    .openapi({ description: "Validation result: 'ok' if model responded, 'error' if it failed" }),
  latencyMs: z
    .number()
    .optional()
    .openapi({ description: "Response time in milliseconds, present when status is 'ok'" }),
  error: z
    .string()
    .optional()
    .openapi({ description: "Error description, present when status is 'error'" }),
  embeddingDim: z.number().int().positive().optional().openapi({
    description:
      "Dimension of the returned embedding vector, present when an embedding model validated successfully",
  }),
});

export const ValidateResponseSchema = z.object({
  validatedAt: z
    .string()
    .openapi({ description: "ISO 8601 timestamp of when validation was performed" }),
  models: z
    .record(z.string(), ModelValidationResultSchema)
    .openapi({ description: "Map of model ID to its validation result" }),
});

export type ModelValidationResult = z.infer<typeof ModelValidationResultSchema>;
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;
