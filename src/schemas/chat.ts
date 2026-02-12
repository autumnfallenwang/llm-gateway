import { z } from "@hono/zod-openapi";

export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
});

const CHOICE_SCHEMA = z.object({
  index: z.number().int(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string(),
  }),
  finish_reason: z.string(),
});

const USAGE_SCHEMA = z.object({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(CHOICE_SCHEMA),
  usage: USAGE_SCHEMA,
});

const CHUNK_DELTA_SCHEMA = z.object({
  role: z.literal("assistant").optional(),
  content: z.string().optional(),
});

const CHUNK_CHOICE_SCHEMA = z.object({
  index: z.number().int(),
  delta: CHUNK_DELTA_SCHEMA,
  finish_reason: z.string().nullable(),
});

export const ChatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(CHUNK_CHOICE_SCHEMA),
});
