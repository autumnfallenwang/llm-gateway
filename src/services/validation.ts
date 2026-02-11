import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { ModelValidationResult, ValidateResponse } from "../schemas/validate.js";
import { listModels, type ResolvedModel, resolveModel } from "./registry.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ValidationConfig {
  validationFilePath?: string;
  concurrency?: number;
  perModelTimeoutMs?: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(homedir(), ".llm-gateway", "models.json");
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 60_000;

// ── Core functions ──────────────────────────────────────────────────────────

export async function validateSingleModel(
  resolved: ResolvedModel,
  timeoutMs: number,
): Promise<ModelValidationResult> {
  const start = Date.now();
  try {
    const result = await complete(
      resolved.model,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [
          {
            role: "user",
            content: "Respond with the word 'hello'",
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 32,
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
  const filePath = config?.validationFilePath ?? DEFAULT_PATH;
  const concurrency = config?.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = config?.perModelTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const allModels = listModels();
  const models: Record<string, ModelValidationResult> = {};

  // biome-ignore lint/suspicious/noConsole: intentional progress log
  console.log(
    `[validation] Starting validation of ${allModels.length} models (concurrency: ${concurrency})`,
  );

  const tasks = allModels.map((m) => async () => {
    const resolved = resolveModel(m.id);
    if (!resolved) {
      return { id: m.id, result: { status: "error" as const, error: "model not resolvable" } };
    }
    // biome-ignore lint/suspicious/noConsole: intentional progress log
    console.log(`[validation] Testing ${m.id}...`);
    const result = await validateSingleModel(resolved, timeoutMs);
    // biome-ignore lint/suspicious/noConsole: intentional progress log
    console.log(
      `[validation] ${m.id}: ${result.status}${result.latencyMs ? ` (${result.latencyMs}ms)` : ""}${result.error ? ` — ${result.error}` : ""}`,
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
  // biome-ignore lint/suspicious/noConsole: intentional progress log
  console.log(
    `[validation] Done: ${okCount}/${allModels.length} models passed. Results saved to ${filePath}`,
  );

  return report;
}

export async function readValidationReport(
  config?: ValidationConfig,
): Promise<ValidateResponse | null> {
  const filePath = config?.validationFilePath ?? DEFAULT_PATH;
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
