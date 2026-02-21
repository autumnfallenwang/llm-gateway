import { readFile, writeFile } from "node:fs/promises";
import { geminiCliOAuthProvider, refreshGoogleCloudToken } from "@mariozechner/pi-ai";
import {
  ANTHROPIC_CREDENTIALS_PATH,
  CODEX_CREDENTIALS_PATH,
  GEMINI_CREDENTIALS_PATH,
  GEMINI_PROJECT_URL,
} from "../config.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface AnthropicCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
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
  anthropicCredentialsPath?: string;
  codexCredentialsPath?: string;
  geminiCredentialsPath?: string;
}

// ── Module state ────────────────────────────────────────────────────────────

let anthropicAccessToken: string | undefined;
let anthropicExpiresAt: number | undefined;
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

// ── Backend credential loaders ──────────────────────────────────────────────

async function loadAnthropicCredentials(path: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf-8");
    const data: AnthropicCredentialsFile = JSON.parse(raw);
    const token = data.claudeAiOauth?.accessToken;
    if (token) {
      anthropicAccessToken = token;
      anthropicExpiresAt = data.claudeAiOauth?.expiresAt;
      const expired = anthropicExpiresAt !== undefined && anthropicExpiresAt < Date.now();
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.log(
        `[auth] Anthropic credentials loaded${expired ? " (expired — upstream may reject)" : ""}`,
      );
    } else {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Anthropic credentials file found but missing accessToken");
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Anthropic credentials not found — backend unavailable");
    } else {
      // biome-ignore lint/suspicious/noConsole: intentional startup log
      console.warn("[auth] Failed to read Anthropic credentials:", (err as Error).message);
    }
  }
}

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
  anthropicAccessToken = undefined;
  anthropicExpiresAt = undefined;
  codexAccessToken = undefined;
  codexExpiresAt = undefined;
  geminiApiKey = undefined;
  geminiExpiresAt = undefined;

  await loadAnthropicCredentials(config?.anthropicCredentialsPath ?? ANTHROPIC_CREDENTIALS_PATH);
  await loadCodexCredentials(config?.codexCredentialsPath ?? CODEX_CREDENTIALS_PATH);
  await loadGeminiCredentials(config?.geminiCredentialsPath ?? GEMINI_CREDENTIALS_PATH);
}

export function getAnthropicKey(): string | undefined {
  return anthropicAccessToken;
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
      available: anthropicAccessToken !== undefined,
      expired: anthropicExpiresAt !== undefined && anthropicExpiresAt < now,
      expiresAt: anthropicExpiresAt,
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
