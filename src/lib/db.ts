import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ModelValidationResult, ValidateResponse } from "../schemas/validate.js";
import { log } from "./logger.js";

/**
 * Persistent state for the gateway. SQLite-backed; replaces the per-state JSON
 * files (`anthropic-credentials.json`, `models.json`) the gateway used in the
 * Docker Compose deploy. Source of truth on a writable PVC at
 * `/home/node/.llm-gateway/state.db` once we cut over to k3s.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface CredentialChain {
  access: string;
  refresh: string;
  expires: number;
}

export interface AppDb {
  readCredentialChain(provider: string): CredentialChain | undefined;
  writeCredentialChain(provider: string, creds: CredentialChain): void;

  readValidationReport(): ValidateResponse | null;
  writeValidationReport(report: ValidateResponse): void;

  raw: Database.Database;
  close(): void;
}

interface ValidationRow {
  model: string;
  status: string;
  latency_ms: number | null;
  error: string | null;
  embedding_dim: number | null;
}

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS credentials_chain (
    provider   TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_validation (
    model         TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    latency_ms    INTEGER,
    error         TEXT,
    embedding_dim INTEGER,
    validated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const META_VALIDATION_BATCH_ISO = "validation.batch_iso";

// ── Implementation ──────────────────────────────────────────────────────────

function makeAppDb(db: Database.Database): AppDb {
  db.exec(SCHEMA);

  const readCredStmt = db.prepare("SELECT payload FROM credentials_chain WHERE provider = ?");
  const writeCredStmt = db.prepare(
    `INSERT INTO credentials_chain (provider, payload, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  );

  const listValidationStmt = db.prepare(
    "SELECT model, status, latency_ms, error, embedding_dim FROM model_validation",
  );
  const deleteValidationStmt = db.prepare("DELETE FROM model_validation");
  const insertValidationStmt = db.prepare(
    `INSERT INTO model_validation (model, status, latency_ms, error, embedding_dim, validated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const readMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  const writeMetaStmt = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  return {
    readCredentialChain(provider) {
      const row = readCredStmt.get(provider) as { payload: string } | undefined;
      if (!row) return undefined;
      try {
        const parsed = JSON.parse(row.payload) as CredentialChain;
        if (
          typeof parsed.access === "string" &&
          typeof parsed.refresh === "string" &&
          typeof parsed.expires === "number"
        ) {
          return parsed;
        }
      } catch {
        // fall through to warn
      }
      log.warn(
        { event: "db.credentials.invalid_payload", provider },
        "Stored credential payload is invalid JSON or malformed; ignoring",
      );
      return undefined;
    },

    writeCredentialChain(provider, creds) {
      writeCredStmt.run(provider, JSON.stringify(creds), Date.now());
    },

    readValidationReport() {
      const batchIso = (
        readMetaStmt.get(META_VALIDATION_BATCH_ISO) as { value: string } | undefined
      )?.value;
      if (!batchIso) return null;
      const rows = listValidationStmt.all() as ValidationRow[];
      if (rows.length === 0) return null;
      const models: Record<string, ModelValidationResult> = {};
      for (const r of rows) {
        const entry: ModelValidationResult = { status: r.status as "ok" | "error" };
        if (r.latency_ms !== null) entry.latencyMs = r.latency_ms;
        if (r.error !== null) entry.error = r.error;
        if (r.embedding_dim !== null) entry.embeddingDim = r.embedding_dim;
        models[r.model] = entry;
      }
      return { validatedAt: batchIso, models };
    },

    writeValidationReport(report) {
      const batchTs = Date.now();
      const writeTx = db.transaction((rep: ValidateResponse) => {
        deleteValidationStmt.run();
        for (const [model, result] of Object.entries(rep.models)) {
          insertValidationStmt.run(
            model,
            result.status,
            result.latencyMs ?? null,
            result.error ?? null,
            result.embeddingDim ?? null,
            batchTs,
          );
        }
        writeMetaStmt.run(META_VALIDATION_BATCH_ISO, rep.validatedAt);
      });
      writeTx(report);
    },

    raw: db,
    close() {
      db.close();
    },
  };
}

export function openDb(path: string): AppDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  return makeAppDb(db);
}

// ── Process-wide singleton ──────────────────────────────────────────────────

let current: AppDb | undefined;

export function setDb(db: AppDb): void {
  current = db;
}

export function getDb(): AppDb {
  if (!current) {
    throw new Error(
      "[db] no AppDb has been initialized — call setDb(openDb(...)) before reading state",
    );
  }
  return current;
}

// ── Legacy JSON → DB import (one-shot, idempotent) ─────────────────────────

interface LegacyAnthropicFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

function readJsonSync<T>(path: string): T | null | "missing" {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    log.warn(
      { event: "db.legacy_import.read_failed", path, err },
      "Failed to read legacy JSON file",
    );
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.warn(
      { event: "db.legacy_import.invalid_json", path },
      "Legacy JSON file is not valid JSON; skipping import",
    );
    return null;
  }
}

function importLegacyAnthropic(db: AppDb, path: string): void {
  if (db.readCredentialChain("anthropic")) {
    log.debug(
      { event: "db.legacy_import.skip", source: "anthropic" },
      "Anthropic credential chain already in DB; skipping legacy import",
    );
    return;
  }
  const parsed = readJsonSync<LegacyAnthropicFile>(path);
  if (!parsed || parsed === "missing") return;
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken || !oauth.refreshToken) return;
  db.writeCredentialChain("anthropic", {
    access: oauth.accessToken,
    refresh: oauth.refreshToken,
    expires: typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0,
  });
  log.info(
    { event: "db.legacy_import.imported", source: "anthropic" },
    "Imported legacy Anthropic credential chain into DB",
  );
}

function importLegacyValidation(db: AppDb, path: string): void {
  if (db.readValidationReport()) {
    log.debug(
      { event: "db.legacy_import.skip", source: "validation" },
      "Validation report already in DB; skipping legacy import",
    );
    return;
  }
  const parsed = readJsonSync<ValidateResponse>(path);
  if (!parsed || parsed === "missing") return;
  if (typeof parsed.validatedAt !== "string" || !parsed.models || typeof parsed.models !== "object")
    return;
  db.writeValidationReport(parsed);
  log.info(
    {
      event: "db.legacy_import.imported",
      source: "validation",
      model_count: Object.keys(parsed.models).length,
    },
    "Imported legacy validation report into DB",
  );
}

/**
 * One-shot import of legacy JSON state into the DB. Idempotent: if a row already
 * exists for the target data, the import is skipped (so this is safe to call on
 * every startup). Source files are left untouched — keeps the rollback path open
 * until Phase 8 cutover finishes.
 */
export function importLegacyJson(
  db: AppDb,
  paths: { anthropicCachePath?: string; validationFilePath?: string },
): void {
  if (paths.anthropicCachePath) importLegacyAnthropic(db, paths.anthropicCachePath);
  if (paths.validationFilePath) importLegacyValidation(db, paths.validationFilePath);
}
