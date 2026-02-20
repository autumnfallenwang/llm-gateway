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
  context_window: z
    .number()
    .int()
    .optional()
    .openapi({ description: "Maximum context window size in tokens" }),
  max_tokens: z
    .number()
    .int()
    .optional()
    .openapi({ description: "Maximum output tokens per completion" }),
});

export const ModelsResponseSchema = z.object({
  object: z.literal("list").openapi({ description: "Always 'list'" }),
  data: z.array(ModelObjectSchema).openapi({ description: "Array of available model objects" }),
});
