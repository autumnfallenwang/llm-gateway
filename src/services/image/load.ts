import { IMAGE_FETCH_MAX_BYTES, IMAGE_FETCH_TIMEOUT_MS } from "../../config.js";

export interface LoadedImage {
  buffer: Buffer;
  mime: string;
}

export class ImageLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageLoadError";
  }
}

const SUPPORTED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
]);

// ── Public API ────────────────────────────────────────────────────────────

export async function loadImage(url: string): Promise<LoadedImage> {
  if (!url) {
    throw new ImageLoadError("Invalid image URL in content part");
  }

  if (url.startsWith("data:")) {
    return parseDataUri(url);
  }
  if (url.startsWith("https://")) {
    return await fetchUrl(url);
  }
  if (url.startsWith("http://")) {
    throw new ImageLoadError("Only HTTPS image URLs are supported");
  }
  throw new ImageLoadError("Invalid image URL in content part");
}

// ── Data URI ──────────────────────────────────────────────────────────────

function parseDataUri(uri: string): LoadedImage {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(uri);
  if (!match) {
    throw new ImageLoadError("Malformed data URI: expected base64-encoded image");
  }

  const data = match[2];
  const buffer = Buffer.from(data, "base64");
  return validateBuffer(buffer);
}

// ── HTTPS Fetch ───────────────────────────────────────────────────────────

async function fetchUrl(url: string): Promise<LoadedImage> {
  assertNotPrivateUrl(url);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ImageLoadError(
        `Image URL fetch timed out after ${Math.round(IMAGE_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw new ImageLoadError(
      `Failed to fetch image URL: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    throw new ImageLoadError(
      `Failed to fetch image URL: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > IMAGE_FETCH_MAX_BYTES) {
    throw new ImageLoadError(`Image exceeds maximum size of ${IMAGE_FETCH_MAX_BYTES} bytes`);
  }

  // Re-check SSRF after redirects
  if (response.url && response.url !== url) {
    assertNotPrivateUrl(response.url);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > IMAGE_FETCH_MAX_BYTES) {
    throw new ImageLoadError(`Image exceeds maximum size of ${IMAGE_FETCH_MAX_BYTES} bytes`);
  }

  return validateBuffer(Buffer.from(arrayBuffer));
}

// ── SSRF Protection ───────────────────────────────────────────────────────

const PRIVATE_HOSTNAME_PATTERNS = [/^localhost$/i, /\.local$/i, /\.internal$/i];

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
];

function assertNotPrivateUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new ImageLoadError("Invalid image URL in content part", { cause: err });
  }

  if (parsed.protocol !== "https:") {
    throw new ImageLoadError("Only HTTPS image URLs are supported");
  }

  const hostname = parsed.hostname;

  if (hostname === "[::1]") {
    throw new ImageLoadError("Private/internal URLs are not allowed");
  }

  for (const pattern of PRIVATE_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new ImageLoadError("Private/internal URLs are not allowed");
    }
  }

  for (const range of PRIVATE_IP_RANGES) {
    if (range.test(hostname)) {
      throw new ImageLoadError("Private/internal URLs are not allowed");
    }
  }
}

// ── MIME Detection ────────────────────────────────────────────────────────

function detectMime(buf: Buffer): string | null {
  if (buf.length < 3) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: 47 49 46 38 (GIF8)
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return "image/gif";
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }

  // HEIC: bytes 4-7 = "ftyp", bytes 8-11 in [heic, heix, hevc, mif1]
  if (buf.length >= 12) {
    const ftyp = buf.subarray(4, 8).toString("ascii");
    if (ftyp === "ftyp") {
      const brand = buf.subarray(8, 12).toString("ascii");
      if (["heic", "heix", "hevc", "mif1"].includes(brand)) {
        return "image/heic";
      }
    }
  }

  return null;
}

// ── Validation ────────────────────────────────────────────────────────────

function validateBuffer(buffer: Buffer): LoadedImage {
  if (buffer.length === 0) {
    throw new ImageLoadError("Image data is empty");
  }

  const mime = detectMime(buffer);
  if (!mime) {
    throw new ImageLoadError("Unable to detect image format from file header");
  }

  if (!SUPPORTED_MIMES.has(mime)) {
    throw new ImageLoadError(`Unsupported image format: ${mime}`);
  }

  return { buffer, mime };
}
