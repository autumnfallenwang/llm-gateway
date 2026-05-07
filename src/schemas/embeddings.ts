import { z } from "@hono/zod-openapi";

const EmbeddingObjectSchema = z.object({
  object: z.literal("embedding").openapi({ description: "Object type, always 'embedding'" }),
  index: z.number().int().openapi({ description: "0-based position matching the input array" }),
  embedding: z.union([z.array(z.number()), z.string()]).openapi({
    description:
      "Vector data — number array (default) or a packed string when base64 was requested",
  }),
});

const EmbeddingsUsageSchema = z.object({
  prompt_tokens: z.number().int().openapi({ description: "Tokens consumed across all inputs" }),
  total_tokens: z
    .number()
    .int()
    .openapi({ description: "Same as prompt_tokens for embeddings (no completion tokens)" }),
});

export const EmbeddingsRequestSchema = z.object({
  model: z.string().min(1).openapi({
    description: "Embedding model ID. Currently must be an Ollama embedding model.",
    example: "bge-m3:latest",
  }),
  input: z.union([z.string(), z.array(z.string()).min(1).max(2048)]).openapi({
    description:
      "Text to embed. Either a single string or an array of strings (batch, max 2048 items). Token-array inputs are not supported.",
    example: "The quick brown fox jumped over the lazy dog",
  }),
  encoding_format: z.enum(["float", "base64"]).optional().openapi({
    description:
      "Output format for the vectors. 'base64' returns each vector as a base64-encoded little-endian float32 byte string (~4× more compact). Defaults to 'float'.",
  }),
  dimensions: z.number().int().positive().optional().openapi({
    description:
      "Truncate vectors to N dimensions (Matryoshka-style). Honored by bge-m3 and OpenAI text-embedding-3-* models.",
  }),
  user: z.string().optional().openapi({
    description:
      "Stable end-user identifier for upstream telemetry. Ollama ignores this; OpenAI uses it for abuse detection.",
  }),
});

export const EmbeddingsResponseSchema = z.object({
  object: z.literal("list").openapi({ description: "Always 'list'" }),
  data: z
    .array(EmbeddingObjectSchema)
    .openapi({ description: "One entry per input, in input order" }),
  model: z.string().openapi({ description: "Model ID that produced the vectors" }),
  usage: EmbeddingsUsageSchema,
});
