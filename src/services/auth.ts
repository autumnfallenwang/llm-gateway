import { readFile, writeFile } from "node:fs/promises";
import {
  geminiCliOAuthProvider,
  refreshAnthropicToken,
  refreshGoogleCloudToken,
} from "@mariozechner/pi-ai";
import {
  ANTHROPIC_CACHE_PATH,
  ANTHROPIC_REFRESH_SKEW_MS,
  ANTHROPIC_SEED_PATH,
  CODEX_CREDENTIALS_PATH,
  GEMINI_CREDENTIALS_PATH,
  GEMINI_PROJECT_URL,
} from "../config.js";

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
  /** Writable cache path inside the container's `~/.llm-gateway` volume. */
  anthropicCachePath?: string;
  codexCredentialsPath?: string;
  geminiCredentialsPath?: string;
}

// ── Module state ────────────────────────────────────────────────────────────

let anthropicCreds: AnthropicCredsState | undefined;
let anthropicCachePath: string = ANTHROPIC_CACHE_PATH;
let anthropicRefreshInFlight: Promise<void> | null = null;

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

// ── Anthropic credential file I/O ──────────────────────────────────────────

async function readAnthropicFile(path: string): Promise<AnthropicCredsState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // biome-ignore lint/suspicious/noConsole: intentional auth log
      console.warn(`[auth] Failed to read Anthropic file ${path}: ${(err as Error).message}`);
    }
    return undefined;
  }
  let data: AnthropicCredentialsFile;
  try {
    data = JSON.parse(raw);
  } catch {
    // biome-ignore lint/suspicious/noConsole: intentional auth log
    console.warn(`[auth] Anthropic file at ${path} is not valid JSON`);
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

async function writeAnthropicCache(path: string, creds: AnthropicCredsState): Promise<void> {
  const payload: AnthropicCredentialsFile = {
    claudeAiOauth: {
      accessToken: creds.access,
      refreshToken: creds.refresh,
      expiresAt: creds.expires,
    },
  };
  try {
    await writeFile(path, JSON.stringify(payload, null, 2));
  } catch (err: unknown) {
    // biome-ignore lint/suspicious/noConsole: intentional auth log
    console.warn(
      `[auth] Failed to write Anthropic cache ${path}: ${(err as Error).message} — refresh succeeded in-memory but won't persist across restart`,
    );
  }
}

// ── Anthropic refresh + lazy ensure ────────────────────────────────────────

async function performAnthropicRefresh(): Promise<void> {
  if (!anthropicCreds) {
    throw new Error("[auth] cannot refresh — no Anthropic credentials loaded");
  }
  const refreshed = await refreshAnthropicToken(anthropicCreds.refresh);
  anthropicCreds = {
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
  };
  await writeAnthropicCache(anthropicCachePath, anthropicCreds);
  // biome-ignore lint/suspicious/noConsole: intentional auth log
  console.log(
    `[auth] Anthropic token refreshed (expires in ${Math.round((anthropicCreds.expires - Date.now()) / 60_000)} min)`,
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

async function loadAnthropicCredentials(seedPath: string, cachePath: string): Promise<void> {
  anthropicCachePath = cachePath;

  // Prefer the container's cache: once we've minted our own chain, never touch the seed again.
  const fromCache = await readAnthropicFile(cachePath);
  if (fromCache) {
    anthropicCreds = fromCache;
    const expired = anthropicCreds.expires < Date.now();
    // biome-ignore lint/suspicious/noConsole: intentional startup log
    console.log(
      `[auth] Anthropic credentials loaded from cache${expired ? " (expired — will refresh on first request)" : ""}`,
    );
    return;
  }

  // First boot: read the host seed, then immediately mint our own chain.
  const fromSeed = await readAnthropicFile(seedPath);
  if (!fromSeed) {
    // biome-ignore lint/suspicious/noConsole: intentional startup log
    console.warn("[auth] Anthropic credentials not found — backend unavailable");
    return;
  }
  anthropicCreds = fromSeed;
  // biome-ignore lint/suspicious/noConsole: intentional startup log
  console.log("[auth] Anthropic credentials seeded from host file — refreshing to mint own chain");

  try {
    await performAnthropicRefresh();
  } catch (err: unknown) {
    // biome-ignore lint/suspicious/noConsole: intentional auth log
    console.warn(
      `[auth] Initial Anthropic refresh failed: ${(err as Error).message} — using seed token until lazy refresh succeeds`,
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
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.log(
        `[auth] Codex credentials loaded${expired ? " (expired — upstream may reject)" : ""}`,
      );
    } else {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Codex credentials file found but missing access_token");
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Codex credentials not found — backend unavailable");
    } else {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Failed to read Codex credentials:", (err as Error).message);
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
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Gemini credentials file found but missing tokens");
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
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Gemini credentials file found but token refresh failed");
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
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.log(`[auth] Gemini credentials loaded (project: ${projectId})`);
    } else {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Gemini token loaded but project discovery failed");
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Gemini credentials not found — backend unavailable");
    } else {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Failed to read Gemini credentials:", (err as Error).message);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadCredentials(config?: AuthConfig): Promise<void> {
  // Reset state
  anthropicCreds = undefined;
  anthropicRefreshInFlight = null;
  codexAccessToken = undefined;
  codexExpiresAt = undefined;
  geminiApiKey = undefined;
  geminiExpiresAt = undefined;

  await loadAnthropicCredentials(
    config?.anthropicSeedPath ?? ANTHROPIC_SEED_PATH,
    config?.anthropicCachePath ?? ANTHROPIC_CACHE_PATH,
  );
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
