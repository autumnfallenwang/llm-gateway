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
    "Generates a model response for the given conversation. Supports Ollama, Anthropic, Codex, and Gemini backends. Set stream=true for Server-Sent Events streaming.",
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
            gemini: {
              summary: "Gemini — gemini-2.5-flash",
              value: {
                model: "gemini-2.5-flash",
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
            "gemini-stream": {
              summary: "Gemini streaming — gemini-2.5-flash",
              value: {
                model: "gemini-2.5-flash",
                messages: [{ role: "user", content: "Explain black holes in two sentences." }],
                max_tokens: 128,
                stream: true,
              },
            },
            "ollama-image": {
              summary: "Ollama vision — qwen3-vl:8b + image URL",
              value: {
                model: "qwen3-vl:8b",
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "Describe this image briefly." },
                      {
                        type: "image_url",
                        image_url: {
                          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
                        },
                      },
                    ],
                  },
                ],
                max_tokens: 128,
              },
            },
            "ollama-image-fallback": {
              summary: "Ollama fallback — qwen3:30b (text-only) + image",
              value: {
                model: "qwen3:30b",
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "Describe this image briefly." },
                      {
                        type: "image_url",
                        image_url: {
                          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
                        },
                      },
                    ],
                  },
                ],
                max_tokens: 128,
              },
            },
            "anthropic-image": {
              summary: "Anthropic vision — Claude Haiku 4.5 + image URL",
              value: {
                model: "claude-haiku-4-5",
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "Describe this image briefly." },
                      {
                        type: "image_url",
                        image_url: {
                          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
                        },
                      },
                    ],
                  },
                ],
                max_tokens: 128,
              },
            },
            "codex-image": {
              summary: "Codex vision — GPT-5.1 + image URL",
              value: {
                model: "gpt-5.1",
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "Describe this image briefly." },
                      {
                        type: "image_url",
                        image_url: {
                          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
                        },
                      },
                    ],
                  },
                ],
                max_tokens: 128,
              },
            },
            "gemini-image": {
              summary: "Gemini vision — gemini-2.0-flash + image URL",
              value: {
                model: "gemini-2.0-flash",
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "Describe this image briefly." },
                      {
                        type: "image_url",
                        image_url: {
                          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
                        },
                      },
                    ],
                  },
                ],
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
          examples: {
            validation: {
              summary: "Request validation error",
              value: {
                error: {
                  message: "Invalid type: Expected string but received undefined",
                  type: "invalid_request_error",
                  param: "model",
                  code: null,
                },
              },
            },
            context_length: {
              summary: "Context length exceeded",
              value: {
                error: {
                  message: "prompt is too long: 250000 tokens > 200000 maximum context length",
                  type: "invalid_request_error",
                  param: null,
                  code: "context_length_exceeded",
                },
              },
            },
            image: {
              summary: "Invalid image",
              value: {
                error: {
                  message: "Invalid image URL: unsupported scheme",
                  type: "invalid_request_error",
                  param: "messages",
                  code: null,
                },
              },
            },
          },
        },
      },
      description:
        "Request validation error (missing/invalid fields), context length exceeded (prompt too long for model), or invalid image (bad URL, unsupported format, fetch failure)",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
          example: {
            error: {
              message: "Model 'nonexistent-model' not found",
              type: "invalid_request_error",
              param: "model",
              code: "model_not_found",
            },
          },
        },
      },
      description: "Model not found in any configured backend",
    },
    429: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
          example: {
            error: {
              message: "Rate limit exceeded, please retry after 30s",
              type: "rate_limit_exceeded",
              param: null,
              code: "rate_limit_exceeded",
            },
          },
        },
      },
      description: "Backend rate limit exceeded — retry after backoff",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
          example: {
            error: {
              message: "Backend request failed: connection refused",
              type: "server_error",
              param: null,
              code: "server_error",
            },
          },
        },
      },
      description: "Unclassified backend error (Ollama/Anthropic/Codex/Gemini)",
    },
    502: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
          example: {
            error: {
              message: "Vision fallback failed: all fallback models exhausted",
              type: "server_error",
              param: null,
              code: "vision_fallback_failed",
            },
          },
        },
      },
      description:
        "Vision fallback failed — text-only model received an image and all vision fallback models failed",
    },
  },
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;
