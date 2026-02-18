import { complete, type Model } from "@mariozechner/pi-ai";
import {
  VISION_FALLBACK_FAMILY,
  VISION_FALLBACK_GENERAL,
  VISION_FALLBACK_MAX_DESCRIPTION_CHARS,
  VISION_FALLBACK_TIMEOUT_MS,
} from "../../config.js";
import type { ChatCompletionRequest } from "../../routes/chat.js";
import type { ContentPart } from "../../schemas/chat.js";
import type { ResolvedModel } from "../registry.js";
import { resolveModel } from "../registry.js";
import { loadImage } from "./load.js";
import { preprocessImage } from "./preprocess.js";

// ── Error ────────────────────────────────────────────────────────────────

export class VisionFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionFallbackError";
  }
}

// ── Provider-to-family mapping ───────────────────────────────────────────

const PROVIDER_TO_FAMILY: Record<string, string> = {
  ollama: "ollama",
  anthropic: "anthropic",
  codex: "openai",
};

// ── Vision system prompt ─────────────────────────────────────────────────

const VISION_SYSTEM_PROMPT =
  "Describe the image(s) in detail, focusing on what the user is asking about. Be factual and concise. Do not answer the user's question — just describe what is visible.";

// ── Public API ───────────────────────────────────────────────────────────

export async function applyVisionFallback(
  body: ChatCompletionRequest,
  resolved: ResolvedModel,
): Promise<ChatCompletionRequest> {
  if (resolved.model.input.includes("image")) return body;
  if (!hasImages(body)) return body;

  const visionResolved = selectVisionModel(resolved.provider);
  if (!visionResolved) {
    throw new VisionFallbackError(
      "No vision-capable fallback model available for image description",
    );
  }

  const transformedMessages = await Promise.all(
    body.messages.map(async (msg) => {
      if (msg.role !== "user" || typeof msg.content === "string") return msg;

      const imageParts = msg.content.filter(
        (p): p is Extract<ContentPart, { type: "image_url" }> => p.type === "image_url",
      );
      if (imageParts.length === 0) return msg;

      const originalText = msg.content
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");

      const description = await describeImages(msg.content, visionResolved);
      const replacementText = buildReplacementContent(description, originalText);

      return { ...msg, content: replacementText };
    }),
  );

  return { ...body, messages: transformedMessages };
}

// ── Internal helpers ─────────────────────────────────────────────────────

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

async function describeImages(
  contentParts: ContentPart[],
  visionResolved: ResolvedModel,
): Promise<string> {
  const piContent: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [];

  for (const part of contentParts) {
    if (part.type === "text") {
      piContent.push({ type: "text", text: part.text });
    } else {
      const loaded = await loadImage(part.image_url.url);
      const processed = await preprocessImage(loaded, part.image_url.detail);
      piContent.push({
        type: "image",
        data: processed.buffer.toString("base64"),
        mimeType: processed.mime,
      });
    }
  }

  let result: Awaited<ReturnType<typeof complete>>;
  try {
    result = await complete(
      visionResolved.model as Model<string>,
      {
        systemPrompt: VISION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: piContent, timestamp: Date.now() }],
      },
      {
        apiKey: visionResolved.apiKey ?? "ollama",
        signal: AbortSignal.timeout(VISION_FALLBACK_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new VisionFallbackError(
      `Vision fallback model failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  if (!text) return "(No description available)";

  if (text.length > VISION_FALLBACK_MAX_DESCRIPTION_CHARS) {
    return `${text.slice(0, VISION_FALLBACK_MAX_DESCRIPTION_CHARS)}...`;
  }

  return text;
}

function buildReplacementContent(description: string, originalText: string): string {
  const parts = [`[Image description: ${description}]`];
  if (originalText) parts.push(originalText);
  return parts.join("\n\n");
}
