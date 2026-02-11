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

const ChoiceSchema = z.object({
  index: z.number().int(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string(),
  }),
  finish_reason: z.string(),
});

const UsageSchema = z.object({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(ChoiceSchema),
  usage: UsageSchema,
});
