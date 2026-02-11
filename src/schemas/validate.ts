import { z } from "@hono/zod-openapi";

export const ModelValidationResultSchema = z.object({
  status: z.enum(["ok", "error"]),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export const ValidateResponseSchema = z.object({
  validatedAt: z.string(),
  models: z.record(z.string(), ModelValidationResultSchema),
});

export type ModelValidationResult = z.infer<typeof ModelValidationResultSchema>;
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;
