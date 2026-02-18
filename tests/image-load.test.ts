import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLoadError, loadImage } from "../src/services/image/load";

// ── Minimal valid image buffers ───────────────────────────────────────────

// 1x1 white JPEG (minimal JFIF)
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

// Minimal PNG header (8-byte signature + IHDR chunk start)
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

// Minimal GIF header (GIF89a)
const GIF_BYTES = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

// Minimal WebP (RIFF + WEBP marker)
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

// Minimal HEIC (ftyp box with heic brand)
const HEIC_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);

function toDataUri(mime: string, buf: Buffer): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ImageLoadError", () => {
  it("is an instance of Error with correct name", () => {
    const err = new ImageLoadError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ImageLoadError");
    expect(err.message).toBe("test");
  });
});

describe("Data URI parsing", () => {
  it("decodes valid JPEG data URI", async () => {
    const result = await loadImage(toDataUri("image/jpeg", JPEG_BYTES));
    expect(result.mime).toBe("image/jpeg");
    expect(Buffer.compare(result.buffer, JPEG_BYTES)).toBe(0);
  });

  it("decodes valid PNG data URI", async () => {
    const result = await loadImage(toDataUri("image/png", PNG_BYTES));
    expect(result.mime).toBe("image/png");
    expect(Buffer.compare(result.buffer, PNG_BYTES)).toBe(0);
  });

  it("rejects malformed data URI (no base64 prefix)", async () => {
    await expect(loadImage("data:image/jpeg,notbase64")).rejects.toThrow(ImageLoadError);
    await expect(loadImage("data:image/jpeg,notbase64")).rejects.toThrow("Malformed data URI");
  });

  it("rejects data URI producing 0-byte buffer", async () => {
    await expect(loadImage("data:image/jpeg;base64,")).rejects.toThrow("Image data is empty");
  });

  it("detects MIME from magic bytes, ignoring declared MIME in URI header", async () => {
    // Declare as PNG but actual bytes are JPEG
    const result = await loadImage(toDataUri("image/png", JPEG_BYTES));
    expect(result.mime).toBe("image/jpeg");
  });
});

describe("HTTPS URL fetching", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  function mockFetchResponse(opts: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    body?: Buffer;
    contentLength?: string | null;
    url?: string;
  }) {
    const body = opts.body ?? JPEG_BYTES;
    const headerInit: Record<string, string> = {};
    if (opts.contentLength !== undefined) {
      if (opts.contentLength !== null) {
        headerInit["content-length"] = opts.contentLength;
      }
    } else {
      headerInit["content-length"] = String(body.length);
    }
    const response = {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: opts.statusText ?? "OK",
      url: opts.url ?? "https://example.com/image.jpg",
      headers: new Headers(headerInit),
      arrayBuffer: () =>
        Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
    };
    vi.mocked(global.fetch).mockResolvedValue(response as unknown as Response);
  }

  it("fetches image and detects MIME from bytes", async () => {
    mockFetchResponse({ body: PNG_BYTES });
    const result = await loadImage("https://example.com/image.png");
    expect(result.mime).toBe("image/png");
    expect(Buffer.compare(result.buffer, PNG_BYTES)).toBe(0);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("rejects non-OK HTTP status", async () => {
    mockFetchResponse({ ok: false, status: 404, statusText: "Not Found" });
    await expect(loadImage("https://example.com/missing.jpg")).rejects.toThrow(
      "HTTP 404 Not Found",
    );
  });

  it("rejects when Content-Length exceeds size cap", async () => {
    mockFetchResponse({ contentLength: "999999999999" });
    await expect(loadImage("https://example.com/huge.jpg")).rejects.toThrow("exceeds maximum size");
  });

  it("rejects when actual body exceeds size cap", async () => {
    // Content-Length header missing but body is too large
    const huge = Buffer.alloc(21 * 1024 * 1024);
    // Write JPEG header so it doesn't fail on MIME detection first
    huge[0] = 0xff;
    huge[1] = 0xd8;
    huge[2] = 0xff;
    mockFetchResponse({ body: huge, contentLength: null });
    await expect(loadImage("https://example.com/huge.jpg")).rejects.toThrow("exceeds maximum size");
  });

  it("wraps timeout errors", async () => {
    const timeoutErr = new DOMException("The operation was aborted", "TimeoutError");
    vi.mocked(global.fetch).mockRejectedValue(timeoutErr);
    await expect(loadImage("https://example.com/slow.jpg")).rejects.toThrow("timed out");
  });
});

describe("SSRF protection", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  it.each([
    ["https://localhost/img.jpg", "localhost"],
    ["https://127.0.0.1/img.jpg", "127.x"],
    ["https://10.0.0.1/img.jpg", "10.x"],
    ["https://172.16.0.1/img.jpg", "172.16.x"],
    ["https://192.168.1.1/img.jpg", "192.168.x"],
    ["https://169.254.0.1/img.jpg", "169.254.x"],
    ["https://[::1]/img.jpg", "::1"],
    ["https://foo.local/img.jpg", ".local"],
    ["https://bar.internal/img.jpg", ".internal"],
  ])("rejects %s (%s)", async (url) => {
    await expect(loadImage(url)).rejects.toThrow("Private/internal URLs");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects http:// URLs", async () => {
    await expect(loadImage("http://example.com/img.jpg")).rejects.toThrow("Only HTTPS");
  });

  it("allows valid HTTPS public URLs", async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://cdn.example.com/image.jpg",
      headers: new Headers({ "content-length": String(JPEG_BYTES.length) }),
      arrayBuffer: () =>
        Promise.resolve(
          JPEG_BYTES.buffer.slice(
            JPEG_BYTES.byteOffset,
            JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength,
          ),
        ),
    };
    vi.mocked(global.fetch).mockResolvedValue(response as unknown as Response);

    const result = await loadImage("https://cdn.example.com/image.jpg");
    expect(result.mime).toBe("image/jpeg");
    expect(global.fetch).toHaveBeenCalledOnce();
  });
});

describe("MIME detection", () => {
  it("detects JPEG from magic bytes", async () => {
    const result = await loadImage(toDataUri("image/jpeg", JPEG_BYTES));
    expect(result.mime).toBe("image/jpeg");
  });

  it("detects PNG from magic bytes", async () => {
    const result = await loadImage(toDataUri("image/png", PNG_BYTES));
    expect(result.mime).toBe("image/png");
  });

  it("detects GIF from magic bytes", async () => {
    const result = await loadImage(toDataUri("image/gif", GIF_BYTES));
    expect(result.mime).toBe("image/gif");
  });

  it("detects WebP from magic bytes", async () => {
    const result = await loadImage(toDataUri("image/webp", WEBP_BYTES));
    expect(result.mime).toBe("image/webp");
  });

  it("detects HEIC from magic bytes", async () => {
    const result = await loadImage(toDataUri("image/heic", HEIC_BYTES));
    expect(result.mime).toBe("image/heic");
  });

  it("rejects unknown magic bytes", async () => {
    const unknown = Buffer.from([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
    ]);
    await expect(loadImage(toDataUri("application/octet-stream", unknown))).rejects.toThrow(
      "Unable to detect image format",
    );
  });

  it("rejects buffer < 3 bytes", async () => {
    const tiny = Buffer.from([0xff, 0xd8]);
    await expect(loadImage(toDataUri("image/jpeg", tiny))).rejects.toThrow(
      "Unable to detect image format",
    );
  });
});

describe("Input validation", () => {
  it("rejects empty URL", async () => {
    await expect(loadImage("")).rejects.toThrow("Invalid image URL");
  });

  it("rejects unsupported protocol", async () => {
    await expect(loadImage("ftp://example.com/img.jpg")).rejects.toThrow("Invalid image URL");
  });
});
