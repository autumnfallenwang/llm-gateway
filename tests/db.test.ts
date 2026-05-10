import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppDb, importLegacyJson, openDb } from "../src/lib/db";

let db: AppDb;
let tempDir: string;

beforeEach(async () => {
  db = openDb(":memory:");
  tempDir = await mkdtemp(join(tmpdir(), "db-test-"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ── Schema ──────────────────────────────────────────────────────────────────

describe("openDb", () => {
  it("creates the credentials_chain, model_validation, and meta tables", () => {
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).filter((n) => !n.startsWith("sqlite_"));
    expect(names).toEqual(
      expect.arrayContaining(["credentials_chain", "meta", "model_validation"]),
    );
  });
});

// ── Credential chain ────────────────────────────────────────────────────────

describe("credential chain", () => {
  it("round-trips a written chain", () => {
    db.writeCredentialChain("anthropic", { access: "a", refresh: "r", expires: 1234 });
    expect(db.readCredentialChain("anthropic")).toEqual({
      access: "a",
      refresh: "r",
      expires: 1234,
    });
  });

  it("upserts on second write (single row per provider)", () => {
    db.writeCredentialChain("anthropic", { access: "old-a", refresh: "old-r", expires: 1 });
    db.writeCredentialChain("anthropic", { access: "new-a", refresh: "new-r", expires: 2 });
    expect(db.readCredentialChain("anthropic")).toEqual({
      access: "new-a",
      refresh: "new-r",
      expires: 2,
    });
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM credentials_chain").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("returns undefined for a missing provider", () => {
    expect(db.readCredentialChain("codex")).toBeUndefined();
  });

  it("returns undefined when stored payload is invalid JSON", () => {
    db.raw
      .prepare("INSERT INTO credentials_chain (provider, payload, updated_at) VALUES (?, ?, ?)")
      .run("anthropic", "not-json{{", Date.now());
    expect(db.readCredentialChain("anthropic")).toBeUndefined();
  });
});

// ── Validation report ───────────────────────────────────────────────────────

describe("validation report", () => {
  it("round-trips a multi-model batch including embeddingDim", () => {
    const validatedAt = new Date().toISOString();
    db.writeValidationReport({
      validatedAt,
      models: {
        "qwen3:30b": { status: "ok", latencyMs: 412 },
        "bge-m3:latest": { status: "ok", latencyMs: 88, embeddingDim: 1024 },
        "broken:1b": { status: "error", error: "timeout" },
      },
    });

    const report = db.readValidationReport();
    expect(report).toEqual({
      validatedAt,
      models: {
        "qwen3:30b": { status: "ok", latencyMs: 412 },
        "bge-m3:latest": { status: "ok", latencyMs: 88, embeddingDim: 1024 },
        "broken:1b": { status: "error", error: "timeout" },
      },
    });
  });

  it("overwrites the previous batch (no row leakage from prior runs)", () => {
    db.writeValidationReport({
      validatedAt: "2026-01-01T00:00:00Z",
      models: { a: { status: "ok" }, b: { status: "ok" }, c: { status: "ok" } },
    });
    db.writeValidationReport({
      validatedAt: "2026-02-01T00:00:00Z",
      models: { only: { status: "error", error: "oops" } },
    });

    const report = db.readValidationReport();
    expect(report?.validatedAt).toBe("2026-02-01T00:00:00Z");
    expect(Object.keys(report?.models ?? {})).toEqual(["only"]);
  });

  it("returns null on an empty DB", () => {
    expect(db.readValidationReport()).toBeNull();
  });
});

// ── Legacy import ───────────────────────────────────────────────────────────

// biome-ignore lint/security/noSecrets: false positive — describe block name not a secret
describe("importLegacyJson", () => {
  function anthropicLegacyPath() {
    return join(tempDir, "anthropic-credentials.json");
  }
  function validationLegacyPath() {
    return join(tempDir, "models.json");
  }

  it("imports an anthropic-credentials.json into the DB on first boot", async () => {
    await writeFile(
      anthropicLegacyPath(),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "legacy-access",
          refreshToken: "legacy-refresh",
          expiresAt: 999_000,
        },
      }),
    );

    importLegacyJson(db, { anthropicCachePath: anthropicLegacyPath() });

    expect(db.readCredentialChain("anthropic")).toEqual({
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: 999_000,
    });
  });

  it("imports a models.json validation report", async () => {
    await writeFile(
      validationLegacyPath(),
      JSON.stringify({
        validatedAt: "2026-04-01T12:00:00Z",
        models: {
          "qwen3:30b": { status: "ok", latencyMs: 250 },
          "bge-m3:latest": { status: "ok", latencyMs: 50, embeddingDim: 1024 },
        },
      }),
    );

    importLegacyJson(db, { validationFilePath: validationLegacyPath() });

    expect(db.readValidationReport()).toEqual({
      validatedAt: "2026-04-01T12:00:00Z",
      models: {
        "qwen3:30b": { status: "ok", latencyMs: 250 },
        "bge-m3:latest": { status: "ok", latencyMs: 50, embeddingDim: 1024 },
      },
    });
  });

  it("is idempotent: skips when a credential row already exists", async () => {
    db.writeCredentialChain("anthropic", { access: "db-access", refresh: "db-r", expires: 1 });
    await writeFile(
      anthropicLegacyPath(),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "would-overwrite",
          refreshToken: "would-overwrite-r",
          expiresAt: 2,
        },
      }),
    );

    importLegacyJson(db, { anthropicCachePath: anthropicLegacyPath() });

    expect(db.readCredentialChain("anthropic")?.access).toBe("db-access");
  });

  it("is idempotent: skips when a validation report already exists", async () => {
    db.writeValidationReport({
      validatedAt: "db-stamp",
      models: { existing: { status: "ok" } },
    });
    await writeFile(
      validationLegacyPath(),
      JSON.stringify({
        validatedAt: "would-overwrite",
        models: { other: { status: "error", error: "x" } },
      }),
    );

    importLegacyJson(db, { validationFilePath: validationLegacyPath() });

    const report = db.readValidationReport();
    expect(report?.validatedAt).toBe("db-stamp");
    expect(Object.keys(report?.models ?? {})).toEqual(["existing"]);
  });

  it("no-ops when legacy files are missing", () => {
    importLegacyJson(db, {
      anthropicCachePath: join(tempDir, "absent-1.json"),
      validationFilePath: join(tempDir, "absent-2.json"),
    });

    expect(db.readCredentialChain("anthropic")).toBeUndefined();
    expect(db.readValidationReport()).toBeNull();
  });

  it("no-ops on malformed JSON without throwing", async () => {
    await writeFile(anthropicLegacyPath(), "not json{{{");
    await writeFile(validationLegacyPath(), "<<broken>>");

    expect(() =>
      importLegacyJson(db, {
        anthropicCachePath: anthropicLegacyPath(),
        validationFilePath: validationLegacyPath(),
      }),
    ).not.toThrow();
    expect(db.readCredentialChain("anthropic")).toBeUndefined();
    expect(db.readValidationReport()).toBeNull();
  });

  it("no-ops on legacy anthropic file that's missing refresh token", async () => {
    await writeFile(
      anthropicLegacyPath(),
      JSON.stringify({ claudeAiOauth: { accessToken: "lone-access" } }),
    );

    importLegacyJson(db, { anthropicCachePath: anthropicLegacyPath() });

    expect(db.readCredentialChain("anthropic")).toBeUndefined();
  });
});
