import { z } from "@hono/zod-openapi";

const TextContentPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ImageContentPartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});

const ContentPartSchema = z.discriminatedUnion("type", [
  TextContentPartSchema,
  ImageContentPartSchema,
]);

export type ContentPart = z.infer<typeof ContentPartSchema>;

const TextOrPartsSchema = z.union([z.string(), z.array(ContentPartSchema).min(1)]);

const REQUEST_TOOL_CALL_SCHEMA = z.object({
  id: z.string().min(1).openapi({ description: "Tool call identifier from the model's response" }),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().openapi({ description: "JSON-encoded function arguments" }),
  }),
});

const SystemMessageSchema = z.object({
  role: z.literal("system").openapi({ description: "Instructions for the model" }),
  content: TextOrPartsSchema,
});

const DeveloperMessageSchema = z.object({
  role: z.literal("developer").openapi({ description: "Newer OpenAI name for 'system'" }),
  content: TextOrPartsSchema,
});

const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: TextOrPartsSchema.openapi({
    description:
      "Text content of the message, or an array of content parts (text and/or image_url)",
  }),
});

const AssistantMessageSchema = z.object({
  role: z.literal("assistant").openapi({ description: "A prior model response" }),
  content: TextOrPartsSchema.nullable()
    .optional()
    .openapi({ description: "Text of the response; null or absent when it only called tools" }),
  tool_calls: z
    .array(REQUEST_TOOL_CALL_SCHEMA)
    .optional()
    .openapi({ description: "Tool calls the model made in that response" }),
});

const ToolMessageSchema = z.object({
  role: z.literal("tool").openapi({ description: "The result of one tool call" }),
  tool_call_id: z
    .string()
    .min(1)
    .openapi({ description: "The id of the assistant tool call this answers" }),
  content: z.union([z.string(), z.array(TextContentPartSchema).min(1)]),
});

export const MessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  DeveloperMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);

export type ChatMessage = z.infer<typeof MessageSchema>;

const ToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/, "letters, digits, '_' or '-', at most 64")
      .openapi({ description: "Function name the model calls", example: "get_weather" }),
    description: z.string().optional(),
    parameters: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: "JSON Schema for the arguments (an object schema)" }),
    strict: z.boolean().nullable().optional().openapi({ description: "Accepted; ignored" }),
  }),
});

export type ChatTool = z.infer<typeof ToolSchema>;

const ToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1) }),
  }),
]);

export type ChatToolChoice = z.infer<typeof ToolChoiceSchema>;

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1).openapi({ description: "Model ID to use", example: "qwen3:30b" }),
    messages: z
      .array(MessageSchema)
      .min(1)
      .openapi({ description: "Conversation messages in chronological order" }),
    temperature: z.number().min(0).max(2).optional().openapi({
      description: "Sampling temperature between 0 (deterministic) and 2 (creative). Defaults to 1",
    }),
    max_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Maximum number of tokens to generate" }),
    max_completion_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Alias for max_tokens (OpenAI-compatible)" }),
    stream: z
      .boolean()
      .optional()
      .default(false)
      .openapi({ description: "If true, returns Server-Sent Events stream. Defaults to false" }),
    tools: z
      .array(ToolSchema)
      .optional()
      .openapi({ description: "Functions the model may call (OpenAI function-calling format)" }),
    tool_choice: ToolChoiceSchema.optional().openapi({
      description:
        "'auto' (default with tools), 'none', 'required', or {type:'function',function:{name}}",
    }),
    parallel_tool_calls: z
      .boolean()
      .optional()
      .openapi({ description: "Accepted for compatibility; the backend decides" }),
  })
  .transform((data) => ({
    ...data,
    max_tokens: data.max_tokens ?? data.max_completion_tokens,
  }));

const TOOL_CALL_FUNCTION_SCHEMA = z.object({
  name: z.string().openapi({ description: "Name of the function to call" }),
  arguments: z.string().openapi({ description: "JSON-encoded string of function arguments" }),
});

const TOOL_CALL_SCHEMA = z.object({
  id: z.string().openapi({ description: "Unique tool call identifier" }),
  type: z.literal("function").openapi({ description: "Always 'function'" }),
  function: TOOL_CALL_FUNCTION_SCHEMA,
});

const CHOICE_SCHEMA = z.object({
  index: z.number().int().openapi({ description: "Choice index, always 0" }),
  message: z.object({
    role: z.literal("assistant").openapi({ description: "Always 'assistant'" }),
    content: z
      .string()
      .nullable()
      .openapi({ description: "Generated text content, null when only tool_calls present" }),
    tool_calls: z
      .array(TOOL_CALL_SCHEMA)
      .optional()
      .openapi({ description: "Tool calls requested by the model, if any" }),
  }),
  finish_reason: z
    .string()
    .openapi({ description: "Why generation stopped: 'stop', 'length', or 'tool_calls'" }),
});

const USAGE_SCHEMA = z.object({
  prompt_tokens: z
    .number()
    .int()
    .openapi({ description: "Number of tokens in the input messages" }),
  completion_tokens: z
    .number()
    .int()
    .openapi({ description: "Number of tokens in the generated output" }),
  total_tokens: z
    .number()
    .int()
    .openapi({ description: "Sum of prompt_tokens and completion_tokens" }),
});

export const ChatCompletionResponseSchema = z.object({
  id: z
    .string()
    .openapi({ description: "Unique completion identifier", example: "chatcmpl-1234567890" }),
  object: z
    .literal("chat.completion")
    .openapi({ description: "Object type, always 'chat.completion'" }),
  created: z
    .number()
    .int()
    .openapi({ description: "Unix timestamp (seconds) when the completion was created" }),
  model: z.string().openapi({ description: "Model ID that generated the completion" }),
  choices: z
    .array(CHOICE_SCHEMA)
    .openapi({ description: "List of completion choices (always 1 element)" }),
  usage: USAGE_SCHEMA,
});

const CHUNK_TOOL_CALL_SCHEMA = z.object({
  index: z.number().int().openapi({ description: "Tool call index" }),
  id: z.string().optional().openapi({
    description: "Unique tool call identifier, present in the first chunk for this tool call",
  }),
  type: z.literal("function").optional().openapi({ description: "Always 'function' when present" }),
  function: z
    .object({
      name: z
        .string()
        .optional()
        .openapi({ description: "Function name, present in the first chunk for this tool call" }),
      arguments: z
        .string()
        .optional()
        .openapi({ description: "Fragment of JSON-encoded function arguments" }),
    })
    .optional(),
});

const CHUNK_DELTA_SCHEMA = z.object({
  role: z
    .literal("assistant")
    .optional()
    .openapi({ description: "Set to 'assistant' in the first chunk only" }),
  content: z.string().optional().openapi({ description: "Token of generated text" }),
  reasoning: z
    .string()
    .optional()
    .openapi({ description: "Token of model reasoning/thinking content" }),
  tool_calls: z
    .array(CHUNK_TOOL_CALL_SCHEMA)
    .optional()
    .openapi({ description: "Tool calls requested by the model, if any" }),
});

const CHUNK_CHOICE_SCHEMA = z.object({
  index: z.number().int().openapi({ description: "Choice index, always 0" }),
  delta: CHUNK_DELTA_SCHEMA,
  finish_reason: z.string().nullable().openapi({
    description: "Null for all chunks except the last, which contains the stop reason",
  }),
});

export const ChatCompletionChunkSchema = z.object({
  id: z.string().openapi({ description: "Unique completion identifier" }),
  object: z
    .literal("chat.completion.chunk")
    .openapi({ description: "Always 'chat.completion.chunk'" }),
  created: z
    .number()
    .int()
    .openapi({ description: "Unix timestamp (seconds) when the completion was created" }),
  model: z.string().openapi({ description: "Model ID that generated the completion" }),
  choices: z
    .array(CHUNK_CHOICE_SCHEMA)
    .openapi({ description: "List of chunk choices (always 1 element)" }),
});
