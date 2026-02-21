import { z } from "@hono/zod-openapi";

export const ModelObjectSchema = z.object({
  id: z.string().openapi({ description: "Model identifier", example: "qwen3:30b" }),
  object: z.literal("model").openapi({ description: "Always 'model'" }),
  created: z
    .number()
    .int()
    .openapi({ description: "Unix timestamp of model creation or last modification" }),
  owned_by: z.string().openapi({
    description: "Model provider: 'ollama', 'anthropic', 'openai-codex', or 'google-gemini-cli'",
  }),
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
  status: z
    .enum(["ok", "error", "unknown"])
    .optional()
    .openapi({ description: "Validation status: ok, error, or unknown (never validated)" }),
  status_detail: z
    .string()
    .nullable()
    .optional()
    .openapi({ description: "Error message when status is 'error', null otherwise" }),
  validated_at: z
    .string()
    .nullable()
    .optional()
    .openapi({ description: "ISO 8601 timestamp of last validation run, null if never validated" }),
});

export const ModelsResponseSchema = z.object({
  object: z.literal("list").openapi({ description: "Always 'list'" }),
  data: z.array(ModelObjectSchema).openapi({ description: "Array of available model objects" }),
});
