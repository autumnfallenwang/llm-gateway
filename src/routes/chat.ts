import { createRoute, type z } from "@hono/zod-openapi";
import { ChatCompletionRequestSchema, ChatCompletionResponseSchema } from "../schemas/chat";
import { ErrorResponseSchema } from "../schemas/error";

export const chatCompletionRoute = createRoute({
  method: "post",
  path: "/v1/chat/completions",
  request: {
    body: {
      content: {
        "application/json": {
          schema: ChatCompletionRequestSchema,
          examples: {
            ollama: {
              summary: "Ollama — qwen3:30b",
              value: {
                model: "qwen3:30b",
                messages: [{ role: "user", content: "Explain black holes in two sentences." }],
                max_tokens: 128,
              },
            },
            anthropic: {
              summary: "Anthropic — Claude Haiku 4.5",
              value: {
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: "Explain black holes in two sentences." }],
                max_tokens: 128,
              },
            },
            codex: {
              summary: "Codex — GPT-5.1",
              value: {
                model: "gpt-5.1",
                messages: [{ role: "user", content: "Explain black holes in two sentences." }],
                max_tokens: 128,
              },
            },
          },
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ChatCompletionResponseSchema,
        },
      },
      description: "Chat completion response",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Validation error or unsupported feature",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Backend error",
    },
  },
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;
