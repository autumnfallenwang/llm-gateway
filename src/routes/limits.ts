import { createRoute } from "@hono/zod-openapi";
import { ErrorResponseSchema } from "../schemas/error";
import { LimitsListSchema, LimitsQuerySchema, LimitsSchema } from "../schemas/limits";

export const limitsRoute = createRoute({
  method: "get",
  path: "/v1/limits",
  operationId: "getLimits",
  summary: "How much of each paid family's allowance is left",
  description:
    "Usage limits for a model (`?model=`) or, without it, every family account-wide. Subscriptions (Claude, GPT via ChatGPT) report windows as percent used plus a reset time; DeepSeek reports its prepaid balance; Ollama models are unlimited. The numbers are the whole account's, including use outside the gateway. Data comes free with chat responses and from each family's account-usage endpoint, cached for a minute. See docs/usage-limits.md.",
  tags: ["Models"],
  request: { query: LimitsQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: LimitsSchema.or(LimitsListSchema) } },
      description: "The model's limits, or a list of every family's",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "A bare model ID more than one provider lists (`ambiguous_model`)",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown model (`model_not_found`)",
    },
  },
});
