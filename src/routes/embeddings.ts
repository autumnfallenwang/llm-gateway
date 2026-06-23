import { createRoute, type z } from "@hono/zod-openapi";
import { EmbeddingsRequestSchema, EmbeddingsResponseSchema } from "../schemas/embeddings";
import { ErrorResponseSchema } from "../schemas/error";

export const embeddingsRoute = createRoute({
  method: "post",
  path: "/v1/embeddings",
  operationId: "createEmbedding",
  summary: "Create embeddings",
  description:
    "Generates embedding vectors for one or more inputs. Currently routes to Ollama embedding models (`bge-m3`, `qwen3-embedding`, `nomic-embed-text`, etc.). Anthropic and Codex providers return 501 — they do not offer embeddings APIs through their OAuth-based access paths. See `docs/openai-embeddings-spec.md` for the full contract.",
  tags: ["Embeddings"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: EmbeddingsRequestSchema,
          examples: {
            ollama: {
              summary: "Ollama — bge-m3 (single string)",
              value: {
                model: "bge-m3:latest",
                input: "The quick brown fox jumped over the lazy dog",
              },
            },
            "ollama-batch": {
              summary: "Ollama — bge-m3 (batch input)",
              value: {
                model: "bge-m3:latest",
                input: ["alpha", "beta", "gamma"],
              },
            },
            "ollama-base64": {
              summary: "Ollama — bge-m3 with compact base64 transport",
              value: {
                model: "bge-m3:latest",
                input: "compact me",
                encoding_format: "base64",
              },
            },
            "ollama-dimensions": {
              summary: "Ollama — bge-m3 truncated to 512 dimensions",
              value: {
                model: "bge-m3:latest",
                input: "truncate me",
                dimensions: 512,
              },
            },
            "ollama-nomic": {
              summary: "Ollama — nomic-embed-text (768-dim)",
              value: {
                model: "nomic-embed-text:latest",
                input: "alternate embedder",
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
          schema: EmbeddingsResponseSchema,
          example: {
            object: "list",
            data: [
              {
                object: "embedding",
                index: 0,
                embedding: [0.0023064255, -0.009327292, -0.0028842222],
              },
            ],
            model: "bge-m3:latest",
            usage: { prompt_tokens: 5, total_tokens: 5 },
          },
        },
      },
      description: "One embedding vector per input, in input order.",
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
                  param: "input",
                  code: null,
                },
              },
            },
            wrong_capability: {
              summary: "Chat model used at /v1/embeddings",
              value: {
                error: {
                  message:
                    "Model 'qwen3:30b' is a chat model. Use POST /v1/chat/completions instead.",
                  type: "invalid_request_error",
                  param: null,
                  code: "wrong_capability",
                },
              },
            },
            invalid_input: {
              summary: "Upstream rejected the input",
              value: {
                error: {
                  message: "invalid input",
                  type: "invalid_request_error",
                  param: null,
                  code: "invalid_input",
                },
              },
            },
          },
        },
      },
      description:
        "Request validation error, capability mismatch (chat model used at /v1/embeddings), or upstream rejected the input.",
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
      description: "Model not registered with this gateway.",
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
      description: "Backend rate limit exceeded.",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
          example: {
            error: {
              message: "Ollama embeddings request failed: connection refused",
              type: "server_error",
              param: null,
              code: "server_error",
            },
          },
        },
      },
      description: "Unclassified backend error.",
    },
    501: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
          example: {
            error: {
              message:
                "Provider 'anthropic' does not offer an embeddings API. Use an Ollama or OpenAI embedding model.",
              type: "invalid_request_error",
              param: null,
              code: "provider_unsupported",
            },
          },
        },
      },
      description:
        "Provider does not offer an embeddings API (Anthropic, Codex in current OAuth paths).",
    },
  },
});

export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;
export type EmbeddingsResponse = z.infer<typeof EmbeddingsResponseSchema>;
