import { z } from "@hono/zod-openapi";

export const ModelObjectSchema = z.object({
  id: z.string().openapi({ description: "Model identifier", example: "qwen3:30b" }),
  object: z.literal("model").openapi({ description: "Always 'model'" }),
  created: z
    .number()
    .int()
    .openapi({ description: "Unix timestamp of model creation or last modification" }),
  owned_by: z
    .string()
    .openapi({ description: "Model provider: 'ollama', 'anthropic', or 'codex'" }),
});

export const ModelsResponseSchema = z.object({
  object: z.literal("list").openapi({ description: "Always 'list'" }),
  data: z.array(ModelObjectSchema).openapi({ description: "Array of available model objects" }),
});
