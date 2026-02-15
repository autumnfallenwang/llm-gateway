import { createRoute, type z } from "@hono/zod-openapi";
import {
  ChatCompletionChunkSchema,
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
} from "../schemas/chat";
import { ErrorResponseSchema } from "../schemas/error";

export const chatCompletionRoute = createRoute({
  method: "post",
  path: "/v1/chat/completions",
  operationId: "createChatCompletion",
  summary: "Create a chat completion",
  description:
    "Generates a model response for the given conversation. Supports Ollama, Anthropic, and Codex backends. Set stream=true for Server-Sent Events streaming.",
  tags: ["Chat"],
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
            "ollama-stream": {
              summary: "Ollama streaming — qwen3:30b",
              value: {
                model: "qwen3:30b",
                messages: [{ role: "user", content: "Explain black holes in two sentences." }],
                max_tokens: 128,
                stream: true,
              },
            },
            "anthropic-stream": {
              summary: "Anthropic streaming — Claude Haiku 4.5",
              value: {
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: "Explain black holes in two sentences." }],
                max_tokens: 128,
                stream: true,
              },
            },
            "codex-stream": {
              summary: "Codex streaming — GPT-5.1",
              value: {
                model: "gpt-5.1",
                messages: [{ role: "user", content: "Explain black holes in two sentences." }],
                max_tokens: 128,
                stream: true,
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
        "text/event-stream": {
          schema: ChatCompletionChunkSchema,
          example: {
            id: "chatcmpl-1234567890",
            object: "chat.completion.chunk",
            created: 1234567890,
            model: "qwen3:30b",
            choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
          },
        },
      },
      description: "Chat completion response (JSON) or SSE stream of chunks when stream=true",
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
