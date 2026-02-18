import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ImageLoadError } from "../src/services/image/load";
import { preprocessImage } from "../src/services/image/preprocess";

// ── Test image generators ─────────────────────────────────────────────────

function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function makePng(width: number, height: number, opts?: { alpha?: boolean }): Promise<Buffer> {
  const channels = opts?.alpha ? 4 : 3;
  const background = channels === 4 ? { r: 0, g: 0, b: 255, alpha: 0.5 } : { r: 0, g: 0, b: 255 };
  return sharp({
    create: { width, height, channels, background },
  })
    .png()
    .toBuffer();
}

function makeWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .webp()
    .toBuffer();
}

function makeGif(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .gif()
    .toBuffer();
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("preprocessImage", () => {
  describe("passthrough (small images)", () => {
    it("returns small JPEG unchanged", async () => {
      const buf = await makeJpeg(100, 100);
      const result = await preprocessImage({ buffer: buf, mime: "image/jpeg" }, "high");
      expect(result.mime).toBe("image/jpeg");
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
      expect(Buffer.compare(result.buffer, buf)).toBe(0);
    });

    it("returns small PNG unchanged", async () => {
      const buf = await makePng(100, 100);
      const result = await preprocessImage({ buffer: buf, mime: "image/png" }, "high");
      expect(result.mime).toBe("image/png");
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
      expect(Buffer.compare(result.buffer, buf)).toBe(0);
    });
  });

  describe("JPEG optimization", () => {
    it("resizes oversized JPEG to fit within 2048px", async () => {
      const buf = await makeJpeg(4000, 3000);
      const result = await preprocessImage({ buffer: buf, mime: "image/jpeg" }, "high");
      expect(result.mime).toBe("image/jpeg");
      expect(result.width).toBeLessThanOrEqual(2048);
      expect(result.height).toBeLessThanOrEqual(2048);
    });

    it("detail: low resizes to within 512px", async () => {
      const buf = await makeJpeg(2000, 1500);
      const result = await preprocessImage({ buffer: buf, mime: "image/jpeg" }, "low");
      expect(result.mime).toBe("image/jpeg");
      expect(result.width).toBeLessThanOrEqual(512);
      expect(result.height).toBeLessThanOrEqual(512);
    });

    it("detail: auto treated as high (2048px)", async () => {
      const buf = await makeJpeg(4000, 3000);
      const result = await preprocessImage({ buffer: buf, mime: "image/jpeg" }, "auto");
      expect(result.mime).toBe("image/jpeg");
      expect(result.width).toBeLessThanOrEqual(2048);
      expect(result.height).toBeLessThanOrEqual(2048);
    });

    it("undefined detail treated as high (2048px)", async () => {
      const buf = await makeJpeg(4000, 3000);
      const result = await preprocessImage({
        buffer: buf,
        mime: "image/jpeg",
      });
      expect(result.mime).toBe("image/jpeg");
      expect(result.width).toBeLessThanOrEqual(2048);
      expect(result.height).toBeLessThanOrEqual(2048);
    });
  });

  describe("PNG with alpha", () => {
    it("keeps PNG format when image has alpha channel", async () => {
      const buf = await makePng(100, 100, { alpha: true });
      const result = await preprocessImage({ buffer: buf, mime: "image/png" }, "high");
      expect(result.mime).toBe("image/png");
    });

    it("resizes oversized alpha PNG", async () => {
      const buf = await makePng(4000, 3000, { alpha: true });
      const result = await preprocessImage({ buffer: buf, mime: "image/png" }, "high");
      expect(result.width).toBeLessThanOrEqual(2048);
      expect(result.height).toBeLessThanOrEqual(2048);
    });
  });

  describe("PNG without alpha", () => {
    it("converts opaque PNG to JPEG on resize", async () => {
      const buf = await makePng(4000, 3000);
      const result = await preprocessImage({ buffer: buf, mime: "image/png" }, "high");
      // Opaque PNG gets resized; since it has no alpha, optimizer uses JPEG
      expect(result.mime).toBe("image/jpeg");
      expect(result.width).toBeLessThanOrEqual(2048);
    });
  });

  describe("WebP conversion", () => {
    it("converts WebP to optimized output", async () => {
      const buf = await makeWebp(4000, 3000);
      const result = await preprocessImage({ buffer: buf, mime: "image/webp" }, "high");
      expect(["image/jpeg", "image/png"]).toContain(result.mime);
      expect(result.width).toBeLessThanOrEqual(2048);
    });
  });

  describe("GIF passthrough", () => {
    it("returns GIF as-is with dimensions", async () => {
      const buf = await makeGif(100, 100);
      const result = await preprocessImage({ buffer: buf, mime: "image/gif" }, "high");
      expect(result.mime).toBe("image/gif");
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
      expect(Buffer.compare(result.buffer, buf)).toBe(0);
    });

    it("throws on oversized GIF", async () => {
      // Create a large buffer with GIF header
      const gifBuf = await makeGif(100, 100);
      // Simulate oversized by creating a buffer that exceeds IMAGE_MAX_BYTES
      const oversized = Buffer.alloc(6 * 1024 * 1024);
      gifBuf.copy(oversized);
      await expect(
        preprocessImage({ buffer: oversized, mime: "image/gif" }, "high"),
      ).rejects.toThrow("GIF exceeds maximum size");
    });
  });

  describe("EXIF rotation", () => {
    it("auto-rotates JPEG with EXIF orientation", async () => {
      // Create a 200x100 JPEG, add EXIF orientation 6 (90° CW)
      // After auto-rotation, dimensions should swap to ~100x200
      const buf = await sharp({
        create: {
          width: 200,
          height: 100,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .jpeg()
        .toBuffer();

      // Use sharp to inject EXIF orientation
      const rotated = await sharp(buf).withMetadata({ orientation: 6 }).toBuffer();

      const result = await preprocessImage({ buffer: rotated, mime: "image/jpeg" }, "high");

      // After auto-rotation of a 200x100 image with orientation 6,
      // the output should be 100x200
      expect(result.width).toBe(100);
      expect(result.height).toBe(200);
    });
  });

  describe("error handling", () => {
    it("throws ImageLoadError on corrupted buffer", async () => {
      const corrupted = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
      await expect(
        preprocessImage({ buffer: corrupted, mime: "image/jpeg" }, "high"),
      ).rejects.toThrow(ImageLoadError);
    });

    it("throws ImageLoadError on empty buffer", async () => {
      await expect(
        preprocessImage({ buffer: Buffer.alloc(0), mime: "image/jpeg" }, "high"),
      ).rejects.toThrow(ImageLoadError);
    });
  });
});
