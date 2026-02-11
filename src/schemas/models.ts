import { z } from "@hono/zod-openapi";

export const ModelObjectSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number().int(),
  owned_by: z.string(),
});

export const ModelsResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(ModelObjectSchema),
});
