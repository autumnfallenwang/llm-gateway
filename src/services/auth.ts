import { readFile, writeFile } from "node:fs/promises";
import {
  geminiCliOAuthProvider,
  refreshAnthropicToken,
  refreshGoogleCloudToken,
} from "@mariozechner/pi-ai";
import {
  ANTHROPIC_REFRESH_SKEW_MS,
  ANTHROPIC_SEED_PATH,
  CODEX_CREDENTIALS_PATH,
  GEMINI_CREDENTIALS_PATH,
  GEMINI_PROJECT_URL,
} from "../config.js";
import { getDb } from "../lib/db.js";
import { log } from "../lib/logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface AnthropicCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

interface CodexCredentialsFile {
  tokens?: {
    access_token?: string;
  };
}

interface GeminiCredentialsFile {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number; // ms epoch
}

/** In-memory Anthropic OAuth state. Mirrors pi-ai's `OAuthCredentials` shape. */
interface AnthropicCredsState {
  access: string;
  refresh: string;
  expires: number; // ms epoch
}

export interface BackendCredentialStatus {
  available: boolean;
  expired: boolean;
  expiresAt: number | undefined;
}

export interface CredentialStatus {
  anthropic: BackendCredentialStatus;
  codex: BackendCredentialStatus;
  gemini: BackendCredentialStatus;
}

export interface AuthConfig {
  /** Read-only seed path (host's `~/.claude/.credentials.json` mount). */
  anthropicSeedPath?: string;
  codexCredentialsPath?: string;
  geminiCredentialsPath?: string;
}

// ── Module state ────────────────────────────────────────────────────────────

let anthropicCreds: AnthropicCredsState | undefined;
let anthropicRefreshInFlight: Promise<void> | null = null;
/** Seed path captured at load time so lazy re-seed (on a dead refresh token) can reach it. */
let anthropicSeedPath: string | undefined;

let codexAccessToken: string | undefined;
let codexExpiresAt: number | undefined;
let geminiApiKey: string | undefined;
let geminiExpiresAt: number | undefined;

// ── Helpers ─────────────────────────────────────────────────────────────────

function decodeJwtExp(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (typeof payload.exp === "number") {
      return payload.exp * 1000; // convert seconds → milliseconds
    }
  } catch {
    // malformed JWT payload
  }
  return undefined;
}

// ── Anthropic credential I/O ───────────────────────────────────────────────

async function readAnthropicSeedFile(path: string): Promise<AnthropicCredsState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn(
        { event: "auth.file.read_failed", provider: "anthropic", path, err },
        "Failed to read Anthropic seed file",
      );
    }
    return undefined;
  }
  let data: AnthropicCredentialsFile;
  try {
    data = JSON.parse(raw);
  } catch {
    log.warn(
      { event: "auth.file.invalid_json", provider: "anthropic", path },
      "Anthropic seed file is not valid JSON",
    );
    return undefined;
  }
  const oauth = data.claudeAiOauth;
  if (!oauth?.accessToken || !oauth?.refreshToken) {
    return undefined;
  }
  return {
    access: oauth.accessToken,
    refresh: oauth.refreshToken,
    expires: typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0,
  };
}

function readAnthropicFromDb(): AnthropicCredsState | undefined {
  return getDb().readCredentialChain("anthropic");
}

function writeAnthropicToDb(creds: AnthropicCredsState): void {
  try {
    getDb().writeCredentialChain("anthropic", creds);
  } catch (err: unknown) {
    log.warn(
      { event: "auth.db.write_failed", provider: "anthropic", err },
      "Failed to persist Anthropic chain to DB — refresh succeeded in-memory but won't survive restart",
    );
  }
}

// ── Anthropic refresh + lazy ensure ────────────────────────────────────────

/** True when a refresh error means the refresh token itself is dead (rotated/consumed). */
function isInvalidGrant(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("invalid_grant") || msg.includes("Refresh token not found");
}

/** Single raw refresh of the in-memory chain. Updates state + DB. Throws on failure. */
async function refreshAnthropicChain(): Promise<void> {
  if (!anthropicCreds) {
    throw new Error("[auth] cannot refresh — no Anthropic credentials loaded");
  }
  const refreshed = await refreshAnthropicToken(anthropicCreds.refresh);
  anthropicCreds = {
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
  };
  writeAnthropicToDb(anthropicCreds);
  log.info(
    {
      event: "auth.refresh.succeeded",
      provider: "anthropic",
      expires_in_min: Math.round((anthropicCreds.expires - Date.now()) / 60_000),
    },
    "Anthropic token refreshed",
  );
}

/**
 * Refresh the Anthropic chain, self-healing if its refresh token is dead.
 *
 * Anthropic refresh tokens are single-use and rotate on every refresh. If the stored chain's
 * token is rejected with `invalid_grant` — e.g. a refresh was lost across a pod restart, or the
 * host re-logged-in and rotated our chain out — we re-read the read-only host seed and mint a
 * brand-new chain from it. This turns what used to be a hard outage (requiring a manual DB wipe +
 * pod restart) into a sub-second automatic recovery on the very next request.
 *
 * The only case this can't fix is the host seed *itself* being dead (the desktop login expired):
 * then the seed's refresh also fails `invalid_grant` and we surface an actionable error.
 */
async function performAnthropicRefresh(): Promise<void> {
  try {
    await refreshAnthropicChain();
    return;
  } catch (err) {
    if (!isInvalidGrant(err)) throw err;
    log.warn(
      { event: "auth.refresh.invalid_grant", provider: "anthropic", err },
      "Anthropic refresh token rejected (invalid_grant) — attempting re-seed from host file",
    );
  }

  const deadRefresh = anthropicCreds?.refresh;
  const fromSeed = anthropicSeedPath ? await readAnthropicSeedFile(anthropicSeedPath) : undefined;
  if (!fromSeed) {
    throw new Error(
      "Anthropic refresh token is invalid and no host seed is available to re-seed from",
    );
  }
  if (fromSeed.refresh === deadRefresh) {
    // The host seed carries the same dead token — the host login itself has expired.
    throw new Error(
      "Anthropic refresh token is invalid and the host seed is stale — re-login on the host (run `claude` and sign in)",
    );
  }

  anthropicCreds = fromSeed;
  await refreshAnthropicChain();
  log.info(
    { event: "auth.reseed.succeeded", provider: "anthropic" },
    "Anthropic chain re-seeded from host file after invalid_grant",
  );
}

/**
 * Ensure the in-memory Anthropic access token is fresh. If expired (or within the safety
 * skew), call `refreshAnthropicToken` and update the cache file. Concurrent calls during
 * an in-flight refresh deduplicate to a single network round-trip — required because
 * Anthropic's refresh tokens rotate, so two parallel refreshes would race and one would lose.
 */
export async function ensureAnthropicFresh(): Promise<void> {
  if (!anthropicCreds) return; // backend unavailable; nothing to refresh
  if (Date.now() < anthropicCreds.expires - ANTHROPIC_REFRESH_SKEW_MS) return;

  if (anthropicRefreshInFlight) {
    await anthropicRefreshInFlight;
    return;
  }

  anthropicRefreshInFlight = performAnthropicRefresh().finally(() => {
    anthropicRefreshInFlight = null;
  });
  await anthropicRefreshInFlight;
}

async function loadAnthropicCredentials(seedPath: string): Promise<void> {
  // Remember the seed path so a lazy re-seed (dead refresh token) can find it later.
  anthropicSeedPath = seedPath;

  // Prefer the DB: once we've minted our own chain, never touch the seed again.
  const fromDb = readAnthropicFromDb();
  if (fromDb) {
    anthropicCreds = fromDb;
    const expired = anthropicCreds.expires < Date.now();
    log.info(
      {
        event: "auth.credentials.loaded",
        provider: "anthropic",
        source: "db",
        expired,
      },
      "Anthropic credentials loaded from DB",
    );
    return;
  }

  // First boot: read the host seed, then immediately mint our own chain.
  const fromSeed = await readAnthropicSeedFile(seedPath);
  if (!fromSeed) {
    log.warn(
      { event: "auth.credentials.unavailable", provider: "anthropic" },
      "Anthropic credentials not found — backend unavailable",
    );
    return;
  }
  anthropicCreds = fromSeed;
  log.info(
    { event: "auth.credentials.seeded", provider: "anthropic" },
    "Anthropic credentials seeded from host file — refreshing to mint own chain",
  );

  try {
    await performAnthropicRefresh();
  } catch (err: unknown) {
    log.warn(
      { event: "auth.refresh.failed", provider: "anthropic", phase: "initial", err },
      "Initial Anthropic refresh failed — using seed token until lazy refresh succeeds",
    );
  }
}

// ── Codex credential loader (unchanged: seed-only, no refresh) ─────────────

async function loadCodexCredentials(path: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf-8");
    const data: CodexCredentialsFile = JSON.parse(raw);
    const token = data.tokens?.access_token;
    if (token) {
      codexAccessToken = token;
      codexExpiresAt = decodeJwtExp(token);
      const expired = codexExpiresAt !== undefined && codexExpiresAt < Date.now();
      log.info(
        { event: "auth.credentials.loaded", provider: "codex", expired },
        "Codex credentials loaded",
      );
    } else {
      log.warn(
        { event: "auth.credentials.malformed", provider: "codex" },
        "Codex credentials file found but missing access_token",
      );
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log.warn(
        { event: "auth.credentials.unavailable", provider: "codex" },
        "Codex credentials not found — backend unavailable",
      );
    } else {
      log.warn(
        { event: "auth.file.read_failed", provider: "codex", err },
        "Failed to read Codex credentials",
      );
    }
  }
}

// ── Gemini OAuth (delegates to pi-ai) ───────────────────────────────────────

async function discoverGeminiProjectId(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(GEMINI_PROJECT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      cloudaicompanionProject?: string;
    };
    return data.cloudaicompanionProject;
  } catch {
    return undefined;
  }
}

async function refreshGeminiAccessToken(
  data: GeminiCredentialsFile,
  geminiPath: string,
): Promise<{ token: string; expiryDate: number } | undefined> {
  if (!data.refresh_token) return undefined;
  try {
    // refreshGoogleCloudToken only needs refreshToken for the HTTP call;
    // projectId is just passed through in the return value
    const refreshed = await refreshGoogleCloudToken(data.refresh_token, "");
    // Persist refreshed token back to credentials file
    try {
      const updated = { ...data, access_token: refreshed.access, expiry_date: refreshed.expires };
      await writeFile(geminiPath, JSON.stringify(updated, null, 2));
    } catch {
      // Non-fatal: token works even if we can't persist
    }
    return { token: refreshed.access, expiryDate: refreshed.expires };
  } catch {
    return undefined;
  }
}

async function loadGeminiCredentials(geminiPath: string): Promise<void> {
  try {
    const raw = await readFile(geminiPath, "utf-8");
    const data: GeminiCredentialsFile = JSON.parse(raw);
    let token = data.access_token;
    let expiryDate = data.expiry_date;

    if (!token && !data.refresh_token) {
      log.warn(
        { event: "auth.credentials.malformed", provider: "gemini" },
        "Gemini credentials file found but missing tokens",
      );
      return;
    }

    // Refresh token first if expired (must happen before project discovery)
    const expired = expiryDate !== undefined && expiryDate < Date.now();
    if (!token || expired) {
      const refreshed = await refreshGeminiAccessToken(data, geminiPath);
      if (refreshed) {
        token = refreshed.token;
        expiryDate = refreshed.expiryDate;
      }
    }

    if (!token) {
      log.warn(
        { event: "auth.refresh.failed", provider: "gemini", phase: "initial" },
        "Gemini credentials file found but token refresh failed",
      );
      return;
    }

    // Discover projectId with a valid (possibly refreshed) token
    const projectId = await discoverGeminiProjectId(token);

    geminiApiKey = geminiCliOAuthProvider.getApiKey({
      refresh: data.refresh_token ?? "",
      access: token,
      expires: expiryDate ?? 0,
      projectId: projectId ?? "",
    });
    geminiExpiresAt = expiryDate;

    if (projectId) {
      log.info(
        { event: "auth.credentials.loaded", provider: "gemini", project_id: projectId },
        "Gemini credentials loaded",
      );
    } else {
      log.warn(
        { event: "auth.project_discovery.failed", provider: "gemini" },
        "Gemini token loaded but project discovery failed",
      );
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log.warn(
        { event: "auth.credentials.unavailable", provider: "gemini" },
        "Gemini credentials not found — backend unavailable",
      );
    } else {
      log.warn(
        { event: "auth.file.read_failed", provider: "gemini", err },
        "Failed to read Gemini credentials",
      );
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadCredentials(config?: AuthConfig): Promise<void> {
  // Reset state
  anthropicCreds = undefined;
  anthropicRefreshInFlight = null;
  anthropicSeedPath = undefined;
  codexAccessToken = undefined;
  codexExpiresAt = undefined;
  geminiApiKey = undefined;
  geminiExpiresAt = undefined;

  await loadAnthropicCredentials(config?.anthropicSeedPath ?? ANTHROPIC_SEED_PATH);
  await loadCodexCredentials(config?.codexCredentialsPath ?? CODEX_CREDENTIALS_PATH);
  await loadGeminiCredentials(config?.geminiCredentialsPath ?? GEMINI_CREDENTIALS_PATH);
}

export function getAnthropicKey(): string | undefined {
  return anthropicCreds?.access;
}

export function getCodexKey(): string | undefined {
  return codexAccessToken;
}

export function getGeminiKey(): string | undefined {
  return geminiApiKey;
}

export function getCredentialStatus(): CredentialStatus {
  const now = Date.now();
  return {
    anthropic: {
      available: anthropicCreds !== undefined,
      expired: anthropicCreds !== undefined && anthropicCreds.expires < now,
      expiresAt: anthropicCreds?.expires,
    },
    codex: {
      available: codexAccessToken !== undefined,
      expired: codexExpiresAt !== undefined && codexExpiresAt < now,
      expiresAt: codexExpiresAt,
    },
    gemini: {
      available: geminiApiKey !== undefined,
      expired: geminiExpiresAt !== undefined && geminiExpiresAt < now,
      expiresAt: geminiExpiresAt,
    },
  };
}
