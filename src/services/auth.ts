import { readFile, stat } from "node:fs/promises";
import {
  ANTHROPIC_REFRESH_SKEW_MS,
  ANTHROPIC_SEED_PATH,
  CODEX_CREDENTIALS_PATH,
  CODEX_ENABLED,
  DEEPSEEK_CREDENTIALS_PATH,
} from "../config.js";
import { getDb } from "../lib/db.js";
import { log } from "../lib/logger.js";
import { refreshAnthropicToken } from "../lib/pi.js";

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
  deepseek: BackendCredentialStatus;
}

export interface AuthConfig {
  /** Read-only seed path (host's `~/.claude/.credentials.json` mount). */
  anthropicSeedPath?: string;
  codexCredentialsPath?: string;
  deepseekCredentialsPath?: string;
}

// ── Module state ────────────────────────────────────────────────────────────

let anthropicCreds: AnthropicCredsState | undefined;
let anthropicRefreshInFlight: Promise<void> | null = null;
/** Seed path captured at load time so lazy re-seed (on a dead refresh token) can reach it. */
let anthropicSeedPath: string | undefined;

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

// ── Host-file credentials (Codex, DeepSeek): read-only, re-read on change ───

/**
 * A credential the host keeps in a file that the gateway only ever reads, mounted from the
 * host like `~/.claude`. Read at load, then again whenever the file's mtime changes — one
 * `stat` per request — so a change on the host is picked up without a restart.
 *
 * - Codex: `~/.codex/auth.json`, the host's ChatGPT login. The gateway never refreshes it:
 *   refresh tokens are single-use, so doing so would log the host's Codex client out of the
 *   login the gateway shares. The host's client (the VS Code ChatGPT extension, or the
 *   `codex` CLI) keeps it fresh — its access tokens last 10 days.
 * - DeepSeek: `~/.deepseek/api_key`, a static API key written once by hand. It's also the
 *   key's single source of truth on the host (`~/.zshrc` reads it for ccsw); see
 *   docs/deepseek-provider.md.
 */
class HostFileCredential {
  key: string | undefined;
  expiresAt: number | undefined;
  private path: string | undefined;
  private mtimeMs: number | undefined;

  constructor(
    private readonly provider: "codex" | "deepseek",
    private readonly label: string,
    /** The key in the file's contents, or undefined when it has none. May throw. */
    private readonly parse: (raw: string) => string | undefined,
  ) {}

  reset(): void {
    this.key = undefined;
    this.expiresAt = undefined;
    this.path = undefined;
    this.mtimeMs = undefined;
  }

  async load(path: string): Promise<void> {
    const provider = this.provider;
    this.path = path;
    try {
      const { mtimeMs } = await stat(path);
      const key = this.parse(await readFile(path, "utf-8"));
      // Recorded once the file parses, so a half-written file is read again next time.
      this.mtimeMs = mtimeMs;
      if (key) {
        this.key = key;
        this.expiresAt = decodeJwtExp(key);
        const expired = this.expiresAt !== undefined && this.expiresAt < Date.now();
        log.info(
          { event: "auth.credentials.loaded", provider, expired },
          `${this.label} credentials loaded`,
        );
      } else {
        log.warn(
          { event: "auth.credentials.malformed", provider },
          `${this.label} credentials file found but holds no key`,
        );
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        log.warn(
          { event: "auth.credentials.unavailable", provider },
          `${this.label} credentials not found — backend unavailable`,
        );
      } else {
        log.warn(
          { event: "auth.file.read_failed", provider, err },
          `Failed to read ${this.label} credentials`,
        );
      }
    }
  }

  /** Re-read the file if it changed since it was last read; keep the key if it's gone. */
  async ensureFresh(): Promise<void> {
    if (!this.path) return;
    let mtimeMs: number;
    try {
      ({ mtimeMs } = await stat(this.path));
    } catch {
      return; // gone or unreadable: keep the key we have
    }
    if (mtimeMs === this.mtimeMs) return;
    await this.load(this.path);
  }

  status(now: number): BackendCredentialStatus {
    return {
      available: this.key !== undefined,
      expired: this.expiresAt !== undefined && this.expiresAt < now,
      expiresAt: this.expiresAt,
    };
  }
}

const codex = new HostFileCredential("codex", "Codex", (raw) => {
  const data: CodexCredentialsFile = JSON.parse(raw);
  return data.tokens?.access_token;
});

const deepseek = new HostFileCredential("deepseek", "DeepSeek", (raw) => raw.trim() || undefined);

/**
 * Pick up a host-file credential (Codex login, DeepSeek key) that changed on the host since
 * it was read: one provider's, or every one's. Never throws.
 */
export async function ensureHostCredentialsFresh(provider?: "codex" | "deepseek"): Promise<void> {
  if (provider !== "deepseek") await codex.ensureFresh();
  if (provider !== "codex") await deepseek.ensureFresh();
}

// Gemini backend removed in the pi-ai 0.73 upgrade: pi-ai dropped its Google/Gemini
// OAuth helpers (geminiCliOAuthProvider / refreshGoogleCloudToken), and the gateway has
// no Gemini subscription. Re-add via pi-ai's generic OAuth provider system if needed.

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadCredentials(config?: AuthConfig): Promise<void> {
  // Reset state
  anthropicCreds = undefined;
  anthropicRefreshInFlight = null;
  anthropicSeedPath = undefined;
  codex.reset();
  deepseek.reset();

  await loadAnthropicCredentials(config?.anthropicSeedPath ?? ANTHROPIC_SEED_PATH);
  // Codex is gated by CODEX_ENABLED, for a host with no ChatGPT login. Skipping the load
  // leaves codexAccessToken undefined, so Codex models never register.
  if (CODEX_ENABLED) {
    await codex.load(config?.codexCredentialsPath ?? CODEX_CREDENTIALS_PATH);
  } else {
    log.info(
      { event: "auth.credentials.disabled", provider: "codex" },
      "Codex disabled via CODEX_ENABLED=false — skipping credential load",
    );
  }
  // No key file, no DeepSeek models.
  await deepseek.load(config?.deepseekCredentialsPath ?? DEEPSEEK_CREDENTIALS_PATH);
}

export function getAnthropicKey(): string | undefined {
  return anthropicCreds?.access;
}

export function getCodexKey(): string | undefined {
  return codex.key;
}

export function getDeepseekKey(): string | undefined {
  return deepseek.key;
}

export function getCredentialStatus(): CredentialStatus {
  const now = Date.now();
  return {
    anthropic: {
      available: anthropicCreds !== undefined,
      expired: anthropicCreds !== undefined && anthropicCreds.expires < now,
      expiresAt: anthropicCreds?.expires,
    },
    codex: codex.status(now),
    deepseek: deepseek.status(now),
  };
}
