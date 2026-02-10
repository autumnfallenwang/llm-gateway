# OpenAI Chat Completions API Specification

Source: https://platform.openai.com/docs/api-reference/chat

## Endpoint

```
POST https://api.openai.com/v1/chat/completions
```

Creates a model response for the given chat conversation.

---

## Request Body

### Required

| Parameter | Type | Description |
|---|---|---|
| `messages` | array | A list of messages comprising the conversation so far. Depending on the model you use, different message types (modalities) are supported, like text, images, and audio. |
| `model` | string | Model ID used to generate the response, like gpt-4o or o3. |

### Optional - Sampling Controls

| Parameter | Type | Default | Description |
|---|---|---|---|
| `temperature` | number | 1 | Between 0 and 2. Higher values like 0.8 make output more random, lower values like 0.2 make it more focused and deterministic. |
| `top_p` | number | 1 | Nucleus sampling. 0.1 means only tokens comprising the top 10% probability mass are considered. Recommend altering this or temperature but not both. |
| `max_completion_tokens` | integer or null | null | Upper bound for tokens that can be generated for a completion, including visible output tokens and reasoning tokens. |
| `max_tokens` | integer or null | null | **Deprecated** in favor of max_completion_tokens. Not compatible with o-series models. |
| `stop` | string/array/null | null | Up to 4 sequences where the API will stop generating further tokens. Not supported with latest reasoning models o3 and o4-mini. |
| `frequency_penalty` | number or null | 0 | Between -2.0 and 2.0. Positive values penalize new tokens based on their existing frequency in the text so far. |
| `presence_penalty` | number or null | 0 | Between -2.0 and 2.0. Positive values penalize new tokens based on whether they appear in the text so far. |
| `logit_bias` | map | null | Modify the likelihood of specified tokens appearing in the completion. Maps token IDs to bias values from -100 to 100. |

### Optional - Streaming

| Parameter | Type | Default | Description |
|---|---|---|---|
| `stream` | boolean or null | false | If true, model response data will be streamed using server-sent events. |
| `stream_options` | object | null | Options for streaming response. Only set this when stream: true. Properties: `include_usage`. |

### Optional - Tools / Function Calling

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tools` | array | null | A list of tools the model may call. You can provide either custom tools or function tools. |
| `tool_choice` | string or object | null | Controls which tool is called. `none`, `auto`, `required`, or specific tool. none is default when no tools present, auto is default if tools are present. |
| `parallel_tool_calls` | boolean | true | Whether to enable parallel function calling during tool use. |

### Optional - Output Format

| Parameter | Type | Default | Description |
|---|---|---|---|
| `response_format` | object | null | Format the model must output. `{"type": "text"}`, `{"type": "json_object"}`, or `{"type": "json_schema", "json_schema": {...}}` for Structured Outputs. |
| `reasoning_effort` | string | medium | Constrains effort on reasoning for reasoning models. Values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `verbosity` | string | medium | Constrains verbosity of response. Values: `low`, `medium`, `high`. |

### Optional - Generation

| Parameter | Type | Default | Description |
|---|---|---|---|
| `n` | integer or null | 1 | How many chat completion choices to generate for each input message. |
| `seed` | integer or null | null | **Deprecated**. Best effort deterministic sampling. |
| `logprobs` | boolean or null | false | Whether to return log probabilities of the output tokens. |
| `top_logprobs` | integer | null | Between 0 and 20. Number of most likely tokens to return at each position. Requires logprobs: true. |

### Optional - Audio

| Parameter | Type | Default | Description |
|---|---|---|---|
| `audio` | object or null | null | Parameters for audio output. Required when audio output is requested with modalities: ["audio"]. |
| `modalities` | array | null | Output types. Default: ["text"]. For audio: ["text", "audio"]. |

### Optional - Web Search

| Parameter | Type | Default | Description |
|---|---|---|---|
| `web_search_options` | object | null | Searches the web for relevant results to use in a response. |

### Optional - Caching & Optimization

| Parameter | Type | Default | Description |
|---|---|---|---|
| `prediction` | object | null | Configuration for Predicted Output. Improves response times when large parts of response are known ahead of time. |
| `prompt_cache_key` | string | null | Used by OpenAI to cache responses for similar requests. |
| `prompt_cache_retention` | string | null | Retention policy for prompt cache. Set to "24h" for extended caching. |

### Optional - Platform / Metadata

| Parameter | Type | Default | Description |
|---|---|---|---|
| `store` | boolean or null | false | Whether to store output for model distillation or evals products. |
| `metadata` | map | null | Set of 16 key-value pairs attached to the object. Keys max 64 chars, values max 512 chars. |
| `service_tier` | string | auto | Processing type: `auto`, `default`, `flex`, `priority`. |
| `safety_identifier` | string | null | Stable identifier for detecting users violating usage policies. |
| `user` | string | null | **Deprecated** in favor of safety_identifier and prompt_cache_key. |

### Deprecated

| Parameter | Type | Description |
|---|---|---|
| `function_call` | string or object | **Deprecated** in favor of tool_choice. |
| `functions` | array | **Deprecated** in favor of tools. |

---

## Response Object

### Non-streaming response

```json
{
  "id": "chatcmpl-B9MBs8CjcvOU2jLn4n570S5qMJKcT",
  "object": "chat.completion",
  "created": 1741569952,
  "model": "gpt-4.1-2025-04-14",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I assist you today?",
        "refusal": null,
        "annotations": []
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 19,
    "completion_tokens": 10,
    "total_tokens": 29,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "audio_tokens": 0
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0,
      "audio_tokens": 0,
      "accepted_prediction_tokens": 0,
      "rejected_prediction_tokens": 0
    }
  },
  "service_tier": "default"
}
```

### Response fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier for the chat completion |
| `object` | string | Always `"chat.completion"` |
| `created` | integer | Unix timestamp of when the completion was created |
| `model` | string | The model used for the completion |
| `choices` | array | List of completion choices |
| `choices[].index` | integer | Index of the choice |
| `choices[].message.role` | string | Always `"assistant"` |
| `choices[].message.content` | string or null | The generated text |
| `choices[].message.refusal` | string or null | Refusal message if applicable |
| `choices[].message.annotations` | array | Annotations if applicable |
| `choices[].message.tool_calls` | array | Tool calls if applicable |
| `choices[].logprobs` | object or null | Log probability information |
| `choices[].finish_reason` | string | `"stop"`, `"length"`, `"tool_calls"`, `"content_filter"` |
| `usage.prompt_tokens` | integer | Number of tokens in the prompt |
| `usage.completion_tokens` | integer | Number of tokens in the generated completion |
| `usage.total_tokens` | integer | Total tokens used (prompt + completion) |
| `usage.prompt_tokens_details.cached_tokens` | integer | Cached tokens |
| `usage.prompt_tokens_details.audio_tokens` | integer | Audio tokens |
| `usage.completion_tokens_details.reasoning_tokens` | integer | Reasoning tokens used |
| `usage.completion_tokens_details.audio_tokens` | integer | Audio tokens |
| `usage.completion_tokens_details.accepted_prediction_tokens` | integer | Accepted prediction tokens |
| `usage.completion_tokens_details.rejected_prediction_tokens` | integer | Rejected prediction tokens |
| `service_tier` | string | The service tier used for processing |

### finish_reason values

| Value | Description |
|---|---|
| `stop` | Model finished naturally or hit a stop sequence |
| `length` | Hit max_tokens / max_completion_tokens limit |
| `tool_calls` | Model decided to call a tool/function |
| `content_filter` | Content was blocked by safety filters |

---

## Streaming Response

When `stream: true`, the response is a sequence of server-sent events (SSE).

Each event has `object: "chat.completion.chunk"` and uses `delta` instead of `message`:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Key differences from non-streaming

| | Non-streaming | Streaming |
|---|---|---|
| `object` | `"chat.completion"` | `"chat.completion.chunk"` |
| Content field | `message` | `delta` |
| Complete at once | Yes | Token by token |
| Usage included | Always | Only with `stream_options: {include_usage: true}` |

---

## Example Request

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-5.2",
    "messages": [
      {
        "role": "developer",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'
```
