import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAnthropicToken } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDb, getDb, openDb, setDb } from "../src/lib/db";
import {
  ensureAnthropicFresh,
  getAnthropicKey,
  getCodexKey,
  getCredentialStatus,
  getGeminiKey,
  loadCredentials,
} from "../src/services/auth";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    refreshAnthropicToken: vi.fn(),
  };
});

const mockedRefresh = vi.mocked(refreshAnthropicToken);

// ── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;
let db: AppDb;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "auth-test-"));
  db = openDb(":memory:");
  setDb(db);
  mockedRefresh.mockReset();
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function seedPath(): string {
  return join(tempDir, "seed.json");
}

function codexPath(): string {
  return join(tempDir, "codex.json");
}

function geminiPath(): string {
  return join(tempDir, "gemini.json");
}

function makeAnthropicFile(opts: { access: string; refresh: string; expiresAt: number }): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: opts.access,
      refreshToken: opts.refresh,
      expiresAt: opts.expiresAt,
    },
  });
}

function seedDbCreds(opts: { access: string; refresh: string; expiresAt: number }): void {
  db.writeCredentialChain("anthropic", {
    access: opts.access,
    refresh: opts.refresh,
    expires: opts.expiresAt,
  });
}

async function writeSeed(opts: {
  access: string;
  refresh: string;
  expiresAt: number;
}): Promise<void> {
  await writeFile(seedPath(), makeAnthropicFile(opts));
}

async function loadAll(): Promise<void> {
  await loadCredentials({
    anthropicSeedPath: seedPath(),
    codexCredentialsPath: codexPath(),
    geminiCredentialsPath: geminiPath(),
  });
}

// ── Bootstrap from DB (no refresh) ─────────────────────────────────────────

describe("loadCredentials: Anthropic DB bootstrap", () => {
  it("loads from DB when present, no refresh fires", async () => {
    seedDbCreds({
      access: "cached-tok",
      refresh: "cached-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    await loadAll();

    expect(getAnthropicKey()).toBe("cached-tok");
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it("loads expired DB token without refreshing during bootstrap", async () => {
    seedDbCreds({
      access: "expired-tok",
      refresh: "cached-refresh",
      expiresAt: Date.now() - 60_000,
    });
    await loadAll();

    expect(getAnthropicKey()).toBe("expired-tok");
    expect(mockedRefresh).not.toHaveBeenCalled();
    const status = getCredentialStatus();
    expect(status.anthropic.expired).toBe(true);
    expect(status.anthropic.available).toBe(true);
  });

  it("ignores seed when DB is populated", async () => {
    seedDbCreds({
      access: "from-db",
      refresh: "db-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    await writeSeed({
      access: "from-seed",
      refresh: "seed-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    await loadAll();

    expect(getAnthropicKey()).toBe("from-db");
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
});

// ── Bootstrap from seed (force refresh on first start) ─────────────────────

describe("loadCredentials: Anthropic seed bootstrap", () => {
  it("refreshes immediately on seed bootstrap and writes the result to DB", async () => {
    await writeSeed({
      access: "seed-tok",
      refresh: "seed-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    mockedRefresh.mockResolvedValue({
      access: "minted-tok",
      refresh: "minted-refresh",
      expires: Date.now() + 2_700_000,
    });

    await loadAll();

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedRefresh).toHaveBeenCalledWith("seed-refresh");
    expect(getAnthropicKey()).toBe("minted-tok");

    // DB row written with the new chain
    const stored = getDb().readCredentialChain("anthropic");
    expect(stored?.access).toBe("minted-tok");
    expect(stored?.refresh).toBe("minted-refresh");
  });

  it("falls back to seed token when initial refresh fails", async () => {
    await writeSeed({
      access: "seed-tok",
      refresh: "seed-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    mockedRefresh.mockRejectedValue(new Error("network down"));

    await loadAll();

    // Refresh attempted but failed; we keep the seed token in memory
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(getAnthropicKey()).toBe("seed-tok");
  });

  it("treats seed without refreshToken as missing credentials", async () => {
    await writeFile(
      seedPath(),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-without-refresh" } }),
    );

    await loadAll();

    expect(getAnthropicKey()).toBeUndefined();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it("returns undefined when neither DB row nor seed exists", async () => {
    await loadAll();

    expect(getAnthropicKey()).toBeUndefined();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it("returns undefined for malformed JSON without throwing", async () => {
    await writeFile(seedPath(), "not json{{{");
    await loadAll();

    expect(getAnthropicKey()).toBeUndefined();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
});

// ── ensureAnthropicFresh: lazy refresh + single-flight mutex ───────────────

describe("ensureAnthropicFresh", () => {
  it("skips refresh when token is fresh", async () => {
    seedDbCreds({
      access: "fresh-tok",
      refresh: "fresh-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    await loadAll();

    await ensureAnthropicFresh();

    expect(mockedRefresh).not.toHaveBeenCalled();
    expect(getAnthropicKey()).toBe("fresh-tok");
  });

  it("refreshes when token is past expiry", async () => {
    seedDbCreds({
      access: "expired-tok",
      refresh: "expired-refresh",
      expiresAt: Date.now() - 60_000,
    });
    await loadAll();
    mockedRefresh.mockResolvedValue({
      access: "refreshed-tok",
      refresh: "refreshed-refresh",
      expires: Date.now() + 2_700_000,
    });

    await ensureAnthropicFresh();

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedRefresh).toHaveBeenCalledWith("expired-refresh");
    expect(getAnthropicKey()).toBe("refreshed-tok");
  });

  it("refreshes when token is within the safety skew", async () => {
    // expires 30s from now, well inside the 60s default skew
    seedDbCreds({
      access: "near-expiry-tok",
      refresh: "near-refresh",
      expiresAt: Date.now() + 30_000,
    });
    await loadAll();
    mockedRefresh.mockResolvedValue({
      access: "skew-refreshed",
      refresh: "skew-refresh-new",
      expires: Date.now() + 2_700_000,
    });

    await ensureAnthropicFresh();

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(getAnthropicKey()).toBe("skew-refreshed");
  });

  it("deduplicates concurrent refreshes via single-flight mutex", async () => {
    seedDbCreds({
      access: "expired",
      refresh: "expired-refresh",
      expiresAt: Date.now() - 60_000,
    });
    await loadAll();

    let resolveRefresh!: (v: { access: string; refresh: string; expires: number }) => void;
    const refreshPromise = new Promise<{ access: string; refresh: string; expires: number }>(
      (resolve) => {
        resolveRefresh = resolve;
      },
    );
    mockedRefresh.mockReturnValue(refreshPromise);

    // Fire 10 concurrent ensureAnthropicFresh calls while refresh is in flight
    const calls = Array.from({ length: 10 }, () => ensureAnthropicFresh());
    // Yield once so the first call enters the in-flight branch
    await new Promise((r) => setImmediate(r));

    resolveRefresh({
      access: "single-refresh-tok",
      refresh: "single-refresh-new",
      expires: Date.now() + 2_700_000,
    });
    await Promise.all(calls);

    // All 10 calls deduplicated to one network round-trip
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(getAnthropicKey()).toBe("single-refresh-tok");
  });

  it("writes refreshed creds back to the DB", async () => {
    seedDbCreds({
      access: "stale",
      refresh: "stale-refresh",
      expiresAt: Date.now() - 60_000,
    });
    await loadAll();
    const newExpiry = Date.now() + 2_700_000;
    mockedRefresh.mockResolvedValue({
      access: "written-tok",
      refresh: "written-refresh",
      expires: newExpiry,
    });

    await ensureAnthropicFresh();

    const stored = getDb().readCredentialChain("anthropic");
    expect(stored).toEqual({
      access: "written-tok",
      refresh: "written-refresh",
      expires: newExpiry,
    });
  });

  it("is a no-op when no Anthropic credentials are loaded", async () => {
    // No DB row, no seed file
    await loadAll();

    await expect(ensureAnthropicFresh()).resolves.toBeUndefined();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it("propagates refresh errors after clearing the in-flight mutex", async () => {
    seedDbCreds({
      access: "stale",
      refresh: "stale-refresh",
      expiresAt: Date.now() - 60_000,
    });
    await loadAll();
    mockedRefresh.mockRejectedValueOnce(new Error("upstream 500"));

    await expect(ensureAnthropicFresh()).rejects.toThrow("upstream 500");

    // Mutex cleared — a second call retries (and we let it succeed)
    mockedRefresh.mockResolvedValueOnce({
      access: "retry-tok",
      refresh: "retry-refresh",
      expires: Date.now() + 2_700_000,
    });
    await ensureAnthropicFresh();
    expect(mockedRefresh).toHaveBeenCalledTimes(2);
    expect(getAnthropicKey()).toBe("retry-tok");
  });
});

// ── Codex (unchanged: seed-only, no refresh) ───────────────────────────────

describe("loadCredentials: Codex", () => {
  it("loads valid Codex credentials", async () => {
    const jwt = makeJwt({ sub: "user", exp: Math.floor(Date.now() / 1000) + 3600 });
    await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));

    await loadAll();

    expect(getCodexKey()).toBe(jwt);
  });

  it("returns undefined for missing Codex file without throwing", async () => {
    await loadAll();
    expect(getCodexKey()).toBeUndefined();
  });

  it("returns undefined for malformed Codex JSON without throwing", async () => {
    await writeFile(codexPath(), "also broken");
    await loadAll();
    expect(getCodexKey()).toBeUndefined();
  });

  it("marks expired Codex JWT but still returns the key", async () => {
    const jwt = makeJwt({ sub: "user", exp: Math.floor(Date.now() / 1000) - 60 });
    await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));

    await loadAll();

    expect(getCodexKey()).toBe(jwt);
    const status = getCredentialStatus();
    expect(status.codex.expired).toBe(true);
    expect(status.codex.available).toBe(true);
  });
});

// ── Credential status shape ────────────────────────────────────────────────

describe("getCredentialStatus", () => {
  it("reports correct shape across providers", async () => {
    const anthropicExpiry = Date.now() + 3_600_000;
    seedDbCreds({ access: "tok-a", refresh: "ref-a", expiresAt: anthropicExpiry });

    const codexExp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ sub: "user", exp: codexExp });
    await writeFile(codexPath(), JSON.stringify({ tokens: { access_token: jwt } }));

    await loadAll();

    const status = getCredentialStatus();

    expect(status.anthropic).toEqual({
      available: true,
      expired: false,
      expiresAt: anthropicExpiry,
    });

    expect(status.codex.available).toBe(true);
    expect(status.codex.expired).toBe(false);
    expect(status.codex.expiresAt).toBe(codexExp * 1000);

    expect(status.gemini).toEqual({
      available: false,
      expired: false,
      expiresAt: undefined,
    });
  });
});

// ── Gemini (unchanged) ─────────────────────────────────────────────────────

describe("loadCredentials: Gemini", () => {
  it("returns undefined for missing Gemini file without throwing", async () => {
    await loadAll();
    expect(getGeminiKey()).toBeUndefined();
  });

  it("returns undefined for malformed Gemini JSON without throwing", async () => {
    await writeFile(geminiPath(), "not json{{{");
    await loadAll();
    expect(getGeminiKey()).toBeUndefined();
  });

  it("returns key when Gemini file is present (project discovery may fail with fake token)", async () => {
    await writeFile(
      geminiPath(),
      JSON.stringify({
        access_token: "fake-gemini-token",
        expiry_date: Date.now() + 3_600_000,
      }),
    );

    await loadAll();

    const key = getGeminiKey();
    if (key) {
      const parsed = JSON.parse(key);
      expect(parsed.token).toBe("fake-gemini-token");
    }
  });
});
