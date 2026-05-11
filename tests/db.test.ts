import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppDb, openDb } from "../src/lib/db";

let db: AppDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
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
