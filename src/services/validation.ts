import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import {
  DEFAULT_SYSTEM_PROMPT,
  VALIDATION_CONCURRENCY,
  VALIDATION_FILE_PATH,
  VALIDATION_MAX_TOKENS,
  VALIDATION_TIMEOUT_MS,
} from "../config.js";
import { log } from "../lib/logger.js";
import type { ModelValidationResult, ValidateResponse } from "../schemas/validate.js";
import { createEmbedding } from "./embeddings.js";
import { listModels, type ResolvedModel, resolveModel } from "./registry.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ValidationConfig {
  validationFilePath?: string;
  concurrency?: number;
  perModelTimeoutMs?: number;
}

// ── Core functions ──────────────────────────────────────────────────────────

async function validateChatModel(
  resolved: ResolvedModel,
  timeoutMs: number,
): Promise<ModelValidationResult> {
  const start = Date.now();
  try {
    const result = await complete(
      resolved.model,
      {
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: "Respond with the word 'hello'",
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: VALIDATION_MAX_TOKENS,
        apiKey: resolved.apiKey ?? "ollama",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    const latencyMs = Date.now() - start;

    const validStopReasons = ["stop", "length"];
    if (!validStopReasons.includes(result.stopReason)) {
      return { status: "error", latencyMs, error: `unexpected stopReason: ${result.stopReason}` };
    }

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    if (!text.trim()) {
      return { status: "error", latencyMs, error: "empty response" };
    }

    return { status: "ok", latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: "error", latencyMs, error: message };
  }
}

async function validateEmbeddingModel(
  resolved: ResolvedModel,
  timeoutMs: number,
): Promise<ModelValidationResult> {
  const start = Date.now();
  try {
    const result = await createEmbedding(
      resolved,
      { model: resolved.model.id, input: "test" },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const latencyMs = Date.now() - start;

    const first = result.data?.[0];
    let dim = 0;
    if (Array.isArray(first?.embedding)) {
      dim = (first.embedding as number[]).length;
    } else if (typeof first?.embedding === "string") {
      dim = first.embedding.length;
    }

    if (!first || dim === 0) {
      return { status: "error", latencyMs, error: "empty embedding vector" };
    }

    return { status: "ok", latencyMs, embeddingDim: dim };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: "error", latencyMs, error: message };
  }
}

export function validateSingleModel(
  resolved: ResolvedModel,
  timeoutMs: number,
): Promise<ModelValidationResult> {
  if (resolved.capability === "embedding") {
    return validateEmbeddingModel(resolved, timeoutMs);
  }
  return validateChatModel(resolved, timeoutMs);
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function validateAllModels(config?: ValidationConfig): Promise<ValidateResponse> {
  const filePath = config?.validationFilePath ?? VALIDATION_FILE_PATH;
  const concurrency = config?.concurrency ?? VALIDATION_CONCURRENCY;
  const timeoutMs = config?.perModelTimeoutMs ?? VALIDATION_TIMEOUT_MS;

  const allModels = listModels();
  const models: Record<string, ModelValidationResult> = {};

  log.info(
    { event: "validation.started", model_count: allModels.length, concurrency },
    "Starting model validation",
  );

  const tasks = allModels.map((m) => async () => {
    const resolved = resolveModel(m.id);
    if (!resolved) {
      return { id: m.id, result: { status: "error" as const, error: "model not resolvable" } };
    }
    log.debug({ event: "validation.testing", model: m.id }, "Testing model");
    const result = await validateSingleModel(resolved, timeoutMs);
    log.info(
      {
        event: "validation.completed",
        model: m.id,
        status: result.status,
        latency_ms: result.latencyMs,
        ...(result.error && { err_message: result.error }),
        ...(result.embeddingDim && { embedding_dim: result.embeddingDim }),
      },
      "Model validation completed",
    );
    return { id: m.id, result };
  });

  const results = await runWithConcurrency(tasks, concurrency);
  for (const { id, result } of results) {
    models[id] = result;
  }

  const report: ValidateResponse = {
    validatedAt: new Date().toISOString(),
    models,
  };

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(report, null, 2));

  const okCount = Object.values(models).filter((m) => m.status === "ok").length;
  log.info(
    {
      event: "validation.done",
      ok_count: okCount,
      total_count: allModels.length,
      file_path: filePath,
    },
    "Validation done",
  );

  return report;
}

export async function readValidationReport(
  config?: ValidationConfig,
): Promise<ValidateResponse | null> {
  const filePath = config?.validationFilePath ?? VALIDATION_FILE_PATH;
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as ValidateResponse;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
