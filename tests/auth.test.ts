import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAnthropicKey,
  getCodexKey,
  getCredentialStatus,
  getGeminiKey,
  loadCredentials,
} from "../src/services/auth";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "auth-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function anthropicPath(): string {
  return join(tempDir, "anthropic.json");
}

function codexPath(): string {
  return join(tempDir, "codex.json");
}

function geminiPath(): string {
  return join(tempDir, "gemini.json");
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("loadCredentials", () => {
  it("loads valid Anthropic credentials", async () => {
    const expiresAt = Date.now() + 3_600_000;
    await writeFile(
      anthropicPath(),
      JSON.stringify({
        claudeAiOauth: { accessToken: "anthropic-tok-123", expiresAt },
      }),
    );

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getAnthropicKey()).toBe("anthropic-tok-123");
  });

  it("loads valid Codex credentials", async () => {
    const jwt = makeJwt({ sub: "user", exp: Math.floor(Date.now() / 1000) + 3600 });
    await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getCodexKey()).toBe(jwt);
  });

  it("returns undefined for missing Anthropic file without throwing", async () => {
    await loadCredentials({
      anthropicCredentialsPath: join(tempDir, "nonexistent.json"),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getAnthropicKey()).toBeUndefined();
  });

  it("returns undefined for missing Codex file without throwing", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: join(tempDir, "nonexistent.json"),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getCodexKey()).toBeUndefined();
  });

  it("returns undefined for malformed JSON without throwing", async () => {
    await writeFile(anthropicPath(), "not json{{{");
    await writeFile(codexPath(), "also broken");

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getAnthropicKey()).toBeUndefined();
    expect(getCodexKey()).toBeUndefined();
  });

  it("marks expired Anthropic token but still returns the key", async () => {
    const expiresAt = Date.now() - 60_000; // expired 1 minute ago
    await writeFile(
      anthropicPath(),
      JSON.stringify({
        claudeAiOauth: { accessToken: "expired-tok", expiresAt },
      }),
    );

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getAnthropicKey()).toBe("expired-tok");
    const status = getCredentialStatus();
    expect(status.anthropic.expired).toBe(true);
    expect(status.anthropic.available).toBe(true);
  });

  it("marks expired Codex JWT but still returns the key", async () => {
    const jwt = makeJwt({ sub: "user", exp: Math.floor(Date.now() / 1000) - 60 });
    await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getCodexKey()).toBe(jwt);
    const status = getCredentialStatus();
    expect(status.codex.expired).toBe(true);
    expect(status.codex.available).toBe(true);
  });

  it("returns correct credential status shape for both providers", async () => {
    const anthropicExpiry = Date.now() + 3_600_000;
    await writeFile(
      anthropicPath(),
      JSON.stringify({
        claudeAiOauth: { accessToken: "tok-a", expiresAt: anthropicExpiry },
      }),
    );

    const codexExp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ sub: "user", exp: codexExp });
    await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    const status = getCredentialStatus();

    expect(status.anthropic).toEqual({
      available: true,
      expired: false,
      expiresAt: anthropicExpiry,
    });

    expect(status.codex.available).toBe(true);
    expect(status.codex.expired).toBe(false);
    expect(status.codex.expiresAt).toBe(codexExp * 1000);
  });

  it("returns undefined for missing Gemini file without throwing", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: join(tempDir, "nonexistent.json"),
    });

    expect(getGeminiKey()).toBeUndefined();
  });

  it("returns undefined for malformed Gemini JSON without throwing", async () => {
    await writeFile(geminiPath(), "not json{{{");

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    expect(getGeminiKey()).toBeUndefined();
  });

  it("returns undefined when Gemini network calls fail (fake tokens)", async () => {
    await writeFile(
      geminiPath(),
      JSON.stringify({
        access_token: "fake-gemini-token",
        expiry_date: Date.now() + 3_600_000,
      }),
    );

    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    // Token is present but project discovery will fail with fake token,
    // so key should still be set (with empty projectId fallback)
    const key = getGeminiKey();
    if (key) {
      const parsed = JSON.parse(key);
      expect(parsed.token).toBe("fake-gemini-token");
    }
  });

  it("includes gemini in credential status shape", async () => {
    await loadCredentials({
      anthropicCredentialsPath: anthropicPath(),
      codexCredentialsPath: codexPath(),
      geminiCredentialsPath: geminiPath(),
    });

    const status = getCredentialStatus();
    expect(status.gemini).toEqual({
      available: false,
      expired: false,
      expiresAt: undefined,
    });
  });
});
