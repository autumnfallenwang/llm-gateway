import { createHash } from "node:crypto";
import {
  VISION_FALLBACK_CACHE_DAYS,
  VISION_FALLBACK_FAMILY,
  VISION_FALLBACK_GENERAL,
  VISION_FALLBACK_MAX_DESCRIPTION_CHARS,
  VISION_FALLBACK_TIMEOUT_MS,
} from "../../config.js";
import { type AppDb, getDb } from "../../lib/db.js";
import { log } from "../../lib/logger.js";
import { complete, type Model, reasoningOptions } from "../../lib/pi.js";
import type { ChatCompletionRequest } from "../../routes/chat.js";
import type { ContentPart } from "../../schemas/chat.js";
import { ensureAnthropicFresh, ensureHostCredentialsFresh } from "../auth.js";
import type { ResolvedModel } from "../registry.js";
import { resolveModel } from "../registry.js";
import { loadImage } from "./load.js";
import { preprocessImage } from "./preprocess.js";

// ── Error ────────────────────────────────────────────────────────────────

export class VisionFallbackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VisionFallbackError";
  }
}

// ── Provider-to-family mapping ───────────────────────────────────────────

const PROVIDER_TO_FAMILY: Record<string, string> = {
  ollama: "ollama",
  anthropic: "anthropic",
  codex: "openai",
  deepseek: "deepseek",
};

// ── Vision prompt ────────────────────────────────────────────────────────

const VISION_SYSTEM_PROMPT =
  "Describe the image in detail, focusing on what the user's message asks about. Be factual and concise. Do not answer the user's question — just describe what is visible.";

/** Part of every cache key: bump it when the prompt or the way images are sent changes. */
const PROMPT_VERSION = "2";

/** Descriptions in flight at once for one request. */
const DESCRIBE_CONCURRENCY = 3;

const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
let lastPrune = 0;

type ImagePart = Extract<ContentPart, { type: "image_url" }>;
type TextPart = Extract<ContentPart, { type: "text" }>;

interface Stats {
  images: number;
  cached: number;
  described: number;
  costUsd: number;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * For a model that can't read images: replaces each image in a user message with a text
 * description of it, written by a vision model of the same family (or the general chain),
 * in the image's place. A message with several images gets one description per image,
 * numbered; the message's parts are joined with blank lines.
 *
 * Descriptions are cached (SQLite) by the image's bytes, the describing model and the
 * message's text. A conversation re-sends its earlier messages unchanged every turn, so each
 * image is described once: later turns cost no model call and read the same text.
 */
export async function applyVisionFallback(
  body: ChatCompletionRequest,
  resolved: ResolvedModel,
): Promise<ChatCompletionRequest> {
  if (resolved.model.input.includes("image")) return body;
  if (!hasImages(body)) return body;

  const selected = selectVisionModel(resolved.provider);
  if (!selected) {
    throw new VisionFallbackError(
      "No vision-capable fallback model available for image description",
    );
  }
  const visionResolved = await withFreshKey(selected);

  const start = Date.now();
  const stats: Stats = { images: 0, cached: 0, described: 0, costUsd: 0 };
  const describe = describer(visionResolved, stats);

  const messages = await Promise.all(
    body.messages.map(async (msg) => {
      if (msg.role !== "user" || typeof msg.content === "string") return msg;
      const images = msg.content.filter((p): p is ImagePart => p.type === "image_url");
      if (images.length === 0) return msg;

      const text = joinText(msg.content);
      const parts = await Promise.all(
        msg.content.map(async (part) => {
          if (part.type === "text") return part.text;
          const n = images.indexOf(part) + 1;
          const description = await describe(part, text, n, images.length);
          const label = images.length > 1 ? `Image ${n} description` : "Image description";
          return `[${label}: ${description}]`;
        }),
      );
      return { ...msg, content: parts.filter((p) => p !== "").join("\n\n") };
    }),
  );

  log.info(
    {
      event: "vision.describe",
      model: resolved.id,
      describer: visionResolved.id,
      images: stats.images,
      cached: stats.cached,
      described: stats.described,
      cost_usd: Math.round(stats.costUsd * 1e6) / 1e6,
      duration_ms: Date.now() - start,
    },
    "Images described for a text-only model",
  );

  return { ...body, messages };
}

// ── Internal helpers ─────────────────────────────────────────────────────

/** The text parts of a message, joined so sentences in separate parts stay apart. */
function joinText(content: ContentPart[]): string {
  return content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .filter((t) => t !== "")
    .join("\n\n");
}

/**
 * The chat route refreshes the requested model's credentials; a fallback model from
 * another provider needs its own, and re-resolving picks up the fresh key.
 */
async function withFreshKey(resolved: ResolvedModel): Promise<ResolvedModel> {
  try {
    if (resolved.provider === "anthropic") await ensureAnthropicFresh();
    else if (resolved.provider === "codex" || resolved.provider === "deepseek") {
      await ensureHostCredentialsFresh(resolved.provider);
    } else return resolved;
  } catch (err) {
    throw new VisionFallbackError(
      `Vision fallback model credentials failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return resolveModel(resolved.id) ?? resolved;
}

function hasImages(body: ChatCompletionRequest): boolean {
  for (const msg of body.messages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    if (msg.content.some((p) => p.type === "image_url")) return true;
  }
  return false;
}

function selectVisionModel(targetProvider: string): ResolvedModel | undefined {
  // Family-first: try same-family vision model
  const familyKey = PROVIDER_TO_FAMILY[targetProvider];
  if (familyKey) {
    const familyModelId = VISION_FALLBACK_FAMILY[familyKey];
    if (familyModelId) {
      const resolved = resolveModel(familyModelId);
      if (resolved?.model.input.includes("image")) return resolved;
    }
  }

  // General fallback chain
  for (const modelId of VISION_FALLBACK_GENERAL) {
    const resolved = resolveModel(modelId);
    if (resolved?.model.input.includes("image")) return resolved;
  }

  return undefined;
}

/** The SQLite cache, or undefined when it's off or no DB is open (unit tests). */
function cache(): AppDb | undefined {
  if (VISION_FALLBACK_CACHE_DAYS <= 0) return undefined;
  try {
    return getDb();
  } catch {
    return undefined;
  }
}

/** Runs at most `max` of the given tasks at once; a finished task hands its slot on. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * One request's describe function: cached descriptions first, the same image (and text)
 * described once within the request, and at most DESCRIBE_CONCURRENCY model calls at once.
 */
function describer(visionResolved: ResolvedModel, stats: Stats) {
  const db = cache();
  const inFlight = new Map<string, Promise<string>>();
  const limit = limiter(DESCRIBE_CONCURRENCY);

  return async (part: ImagePart, text: string, n: number, total: number): Promise<string> => {
    stats.images++;
    const loaded = await loadImage(part.image_url.url);
    const detail = part.image_url.detail;
    const key = createHash("sha256")
      .update([PROMPT_VERSION, visionResolved.id, detail ?? "", `${n}/${total}`, text].join("\0"))
      .update("\0")
      .update(loaded.buffer)
      .digest("hex");

    const pending = inFlight.get(key);
    if (pending) {
      stats.cached++;
      return pending;
    }
    const since = Date.now() - VISION_FALLBACK_CACHE_DAYS * DAY_MS;
    const stored = readCached(db, key, since);
    if (stored !== undefined) {
      stats.cached++;
      return stored;
    }

    const described = limit(async () => {
      const processed = await preprocessImage(loaded, detail);
      const result = await describeImage(visionResolved, processed, text, n, total);
      stats.described++;
      stats.costUsd += result.costUsd;
      if (result.ok) writeCached(db, key, visionResolved.id, result.text);
      return result.text;
    });
    inFlight.set(key, described);
    return described;
  };
}

function readCached(db: AppDb | undefined, key: string, since: number): string | undefined {
  if (!db) return undefined;
  try {
    return db.readImageDescription(key, since);
  } catch (err) {
    log.warn({ event: "vision.cache_failed", err }, "Couldn't read the image description cache");
    return undefined;
  }
}

function writeCached(db: AppDb | undefined, key: string, model: string, text: string): void {
  if (!db) return;
  try {
    db.writeImageDescription(key, model, text);
    const now = Date.now();
    if (now - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = now;
      db.pruneImageDescriptions(now - VISION_FALLBACK_CACHE_DAYS * DAY_MS);
    }
  } catch (err) {
    log.warn({ event: "vision.cache_failed", err }, "Couldn't write the image description cache");
  }
}

/** Describes one image. `ok` is false when there's nothing worth caching. */
async function describeImage(
  visionResolved: ResolvedModel,
  image: { buffer: Buffer; mime: string },
  text: string,
  n: number,
  total: number,
): Promise<{ text: string; ok: boolean; costUsd: number }> {
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [];
  if (text) content.push({ type: "text", text: `The user's message:\n\n${text}` });
  if (total > 1) content.push({ type: "text", text: `Describe image ${n} of ${total} in it.` });
  content.push({ type: "image", data: image.buffer.toString("base64"), mimeType: image.mime });

  let result: Awaited<ReturnType<typeof complete>>;
  try {
    result = await complete(
      visionResolved.model as Model<string>,
      {
        systemPrompt: VISION_SYSTEM_PROMPT,
        messages: [{ role: "user", content, timestamp: Date.now() }],
      },
      {
        // A description needs no reasoning; it would only slow the fallback down.
        ...reasoningOptions(visionResolved.model as Model<string>, "none"),
        apiKey: visionResolved.apiKey ?? "ollama",
        signal: AbortSignal.timeout(VISION_FALLBACK_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new VisionFallbackError(
      `Vision fallback model failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const costUsd = result.usage?.cost?.total ?? 0;
  if (result.stopReason === "error") {
    log.warn(
      { event: "vision.describe_failed", describer: visionResolved.id, error: result.errorMessage },
      "Vision fallback model failed to describe an image",
    );
    return { text: "(No description available)", ok: false, costUsd };
  }

  const description = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (!description) return { text: "(No description available)", ok: false, costUsd };
  if (description.length > VISION_FALLBACK_MAX_DESCRIPTION_CHARS) {
    return {
      text: `${description.slice(0, VISION_FALLBACK_MAX_DESCRIPTION_CHARS)}...`,
      ok: true,
      costUsd,
    };
  }
  return { text: description, ok: true, costUsd };
}
