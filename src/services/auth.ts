import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface BackendCredentialStatus {
  available: boolean;
  expired: boolean;
  expiresAt: number | undefined;
}

export interface CredentialStatus {
  anthropic: BackendCredentialStatus;
  codex: BackendCredentialStatus;
}

export interface AuthConfig {
  anthropicCredentialsPath?: string;
  codexCredentialsPath?: string;
}

// ── Module state ────────────────────────────────────────────────────────────

let anthropicAccessToken: string | undefined;
let anthropicExpiresAt: number | undefined;
let codexAccessToken: string | undefined;
let codexExpiresAt: number | undefined;

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

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadCredentials(config?: AuthConfig): Promise<void> {
  const anthropicPath =
    config?.anthropicCredentialsPath ?? join(homedir(), ".claude", ".credentials.json");
  const codexPath = config?.codexCredentialsPath ?? join(homedir(), ".codex", "auth.json");

  // Reset state
  anthropicAccessToken = undefined;
  anthropicExpiresAt = undefined;
  codexAccessToken = undefined;
  codexExpiresAt = undefined;

  // ── Anthropic ───────────────────────────────────────────────────────────
  try {
    const raw = await readFile(anthropicPath, "utf-8");
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

  // ── Codex ───────────────────────────────────────────────────────────────
  try {
    const raw = await readFile(codexPath, "utf-8");
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

export function getAnthropicKey(): string | undefined {
  return anthropicAccessToken;
}

export function getCodexKey(): string | undefined {
  return codexAccessToken;
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
  };
}
