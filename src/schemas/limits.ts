import { z } from "@hono/zod-openapi";

const StatusSchema = z.enum(["ok", "warning", "exhausted"]);

const WindowSchema = z.object({
  scope: z.string().openapi({
    description: "`all models`, or the model family a scoped limit covers (e.g. `Fable`)",
  }),
  period: z
    .string()
    .openapi({ description: "`5h`, `daily`, `weekly`, `monthly`, or a length like `12h`" }),
  used_percent: z.number().openapi({ description: "Share of the window's allowance used, 0–100" }),
  resets_at: z.string().nullable().openapi({ description: "When the window resets (ISO 8601)" }),
  status: StatusSchema,
});

const BalanceSchema = z.object({
  amount: z.number().openapi({ description: "Money left on a prepaid account" }),
  currency: z.string(),
});

const AvailableSchema = z
  .union([
    z.object({
      kind: z.literal("percent"),
      percent_left: z.number().openapi({ description: "100 minus the binding window's use" }),
      resets_at: z.string().nullable(),
      binding: z
        .string()
        .openapi({ description: "The window closest to running out, e.g. `weekly · all models`" }),
    }),
    z.object({ kind: z.literal("balance"), amount: z.number(), currency: z.string() }),
    z.object({ kind: z.literal("unlimited").openapi({ description: "A local model (Ollama)" }) }),
    z.object({
      kind: z.literal("unknown").openapi({ description: "No limit data could be fetched yet" }),
    }),
    z.object({
      kind: z.literal("unavailable").openapi({
        description: 'The model failed its last check (`/v1/models` `status: "error"`)',
      }),
      reason: z.string().openapi({
        description: "Why, as /v1/models' `status_detail` says (e.g. not on the ChatGPT plan)",
      }),
    }),
  ])
  .openapi({
    description: "The one line to show: percent left (subscriptions) or money left (prepaid)",
  });

export const LimitsSchema = z
  .object({
    model: z
      .string()
      .nullable()
      .openapi({ description: "The model (as /v1/models lists it), or null for a whole family" }),
    provider: z
      .string()
      .openapi({ description: "`owned_by`: anthropic, openai-codex, deepseek, ollama" }),
    plan: z
      .string()
      .nullable()
      .openapi({ description: "The account's plan, when the provider says (`go`, `prepaid`)" }),
    status: z.enum(["ok", "warning", "exhausted", "unknown", "unavailable"]).openapi({
      description:
        "Worst of the windows that apply (and the provider's own verdict); `unknown` when no data, or it's stale; `unavailable` when the model failed its last check, however much allowance is left",
    }),
    available: AvailableSchema,
    windows: z.array(WindowSchema).openapi({
      description: "Every window that applies to the model; for a family, all of its windows",
    }),
    balance: BalanceSchema.nullable(),
    details: z.record(z.string(), z.unknown()).openapi({
      description: "Family-specific extras, as the provider reports them; not guaranteed stable",
    }),
    as_of: z.string().nullable().openapi({ description: "When this data was current (ISO 8601)" }),
    source: z.enum(["response", "usage endpoint"]).nullable().openapi({
      description:
        "Where it came from: a chat response's headers/events, or the account-usage endpoint",
    }),
  })
  .openapi("Limits");

export const LimitsListSchema = z.object({
  object: z.literal("list"),
  data: z.array(LimitsSchema).openapi({ description: "One entry per family, account-wide" }),
});

export const LimitsQuerySchema = z.object({
  model: z.string().min(1).optional().openapi({
    description: "A model ID (bare or `owned_by/model`). Omitted: every family, account-wide",
    example: "claude-fable-5-1",
  }),
});
