import sharp from "sharp";
import { IMAGE_LOW_DETAIL_MAX_PX, IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION_PX } from "../../config.js";
import { ImageLoadError } from "./load.js";

export interface LoadedImage {
  buffer: Buffer;
  mime: string;
}

export interface PreprocessedImage {
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
}

export type DetailLevel = "high" | "low" | "auto";

// ── Public API ────────────────────────────────────────────────────────────

export async function preprocessImage(
  image: LoadedImage,
  detail?: DetailLevel,
): Promise<PreprocessedImage> {
  const maxPx = detail === "low" ? IMAGE_LOW_DETAIL_MAX_PX : IMAGE_MAX_DIMENSION_PX;

  // GIF passthrough — no resize, just enforce size cap
  if (image.mime === "image/gif") {
    const meta = await getMetadata(image.buffer);
    if (image.buffer.length > IMAGE_MAX_BYTES) {
      throw new ImageLoadError(`GIF exceeds maximum size of ${IMAGE_MAX_BYTES} bytes`);
    }
    return {
      buffer: image.buffer,
      mime: "image/gif",
      width: meta.width,
      height: meta.height,
    };
  }

  // HEIC → JPEG conversion
  let { buffer, mime } = image;
  if (mime === "image/heic") {
    buffer = await sharp(buffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    mime = "image/jpeg";
  }

  const meta = await getMetadata(buffer);

  // Short-circuit: already fits constraints, no processing needed
  const maxSide = Math.max(meta.width, meta.height);
  if (
    maxSide <= maxPx &&
    buffer.length <= IMAGE_MAX_BYTES &&
    !meta.needsRotation &&
    (mime === "image/jpeg" || mime === "image/png")
  ) {
    return { buffer, mime, width: meta.width, height: meta.height };
  }

  // Alpha images: try PNG first, fall back to JPEG
  if (meta.hasAlpha) {
    const pngResult = await optimizeToPng(buffer, maxPx);
    if (pngResult) {
      return pngResult;
    }
    // PNG couldn't fit under cap — fall back to JPEG
  }

  return optimizeToJpeg(buffer, maxPx);
}

// ── JPEG Grid Search ──────────────────────────────────────────────────────

async function optimizeToJpeg(buffer: Buffer, maxPx: number): Promise<PreprocessedImage> {
  const sizes = dedupeDescending([maxPx, 1536, 1280, 1024, 800].filter((s) => s <= maxPx));
  const qualities = [80, 70, 60, 50, 40];

  let smallest: { buffer: Buffer; width: number; height: number } | null = null;

  for (const size of sizes) {
    for (const quality of qualities) {
      const result = await sharp(buffer)
        .rotate()
        .resize({
          width: size,
          height: size,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });

      const out = result.data;
      const { width, height } = result.info;

      if (!smallest || out.length < smallest.buffer.length) {
        smallest = { buffer: out, width, height };
      }
      if (out.length <= IMAGE_MAX_BYTES) {
        return { buffer: out, mime: "image/jpeg", width, height };
      }
    }
  }

  if (smallest && smallest.buffer.length <= IMAGE_MAX_BYTES) {
    return {
      buffer: smallest.buffer,
      mime: "image/jpeg",
      width: smallest.width,
      height: smallest.height,
    };
  }

  throw new ImageLoadError(`Image could not be reduced below ${IMAGE_MAX_BYTES} bytes`);
}

// ── PNG Grid Search (alpha images) ────────────────────────────────────────

async function optimizeToPng(buffer: Buffer, maxPx: number): Promise<PreprocessedImage | null> {
  const sizes = dedupeDescending([maxPx, 1536, 1280, 1024, 800].filter((s) => s <= maxPx));
  const compressionLevels = [6, 7, 8, 9];

  let smallest: { buffer: Buffer; width: number; height: number } | null = null;

  for (const size of sizes) {
    for (const compressionLevel of compressionLevels) {
      const result = await sharp(buffer)
        .rotate()
        .resize({
          width: size,
          height: size,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png({ compressionLevel })
        .toBuffer({ resolveWithObject: true });

      const out = result.data;
      const { width, height } = result.info;

      if (!smallest || out.length < smallest.buffer.length) {
        smallest = { buffer: out, width, height };
      }
      if (out.length <= IMAGE_MAX_BYTES) {
        return { buffer: out, mime: "image/png", width, height };
      }
    }
  }

  // PNG couldn't fit — return null so caller falls back to JPEG
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function getMetadata(
  buffer: Buffer,
): Promise<{ width: number; height: number; hasAlpha: boolean; needsRotation: boolean }> {
  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new ImageLoadError("Unable to read image dimensions");
    }
    // EXIF orientation > 1 means the image needs rotation/flip
    const needsRotation = (meta.orientation ?? 1) > 1;
    return { width, height, hasAlpha: meta.hasAlpha ?? false, needsRotation };
  } catch (err) {
    if (err instanceof ImageLoadError) throw err;
    throw new ImageLoadError(
      `Failed to read image metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function dedupeDescending(arr: number[]): number[] {
  return [...new Set(arr)].sort((a, b) => b - a);
}
