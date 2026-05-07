# llm-gateway Hotfix: Anthropic Token Refresh in Container

Handoff doc for the production "Connection error." regression on Anthropic streaming completions, traced to two interacting bugs in how llmgw consumes credentials inside Docker.

## TL;DR

- Production gateway returns `Connection error.` on `POST /v1/chat/completions` for any Anthropic model.
- Root cause is **two stacked bugs**:
  1. `deploy/compose.yaml` uses a **single-file bind-mount** (`~/.claude/.credentials.json:/.../...credentials.json:ro`). The Claude CLI on the host rotates that file via atomic rename, which changes the inode. The container's mount is pinned to the old inode and never sees the new file. From the container's view, the token is frozen at first-mount time.
  2. `src/services/auth.ts` `loadAnthropicCredentials()` does **not** call `refreshAnthropicToken()` — it only re-reads the file from disk. The `setInterval` cron in `src/index.ts` fires every 30 min and dutifully re-reads the same frozen-inode file. There is no real OAuth refresh anywhere in the Anthropic path.
- Even fixing one of these in isolation is incomplete: a directory mount alone still depends on the host CLI being active and refreshing on time; an OAuth refresh path alone still needs to be reading a file the host can update.
- The fix is to make the **container its own OAuth client**: seed from the host file once, then maintain an independent token chain in a writable volume the container owns.
- Replace the cron with **lazy refresh + a single-flight mutex**, matching the pattern the Claude CLI itself uses.

## Symptom

```
$ curl -X POST http://localhost:51277/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}],"stream":true}'
data: {"error":{"message":"Connection error.","type":"server_error","code":null,"param":null}}
```

Direct calls against Anthropic with the same access token recovered from `~/.claude/.credentials.json` on the host work, while the container's cached copy fails. That's the smoking gun: the container is using a stale token.

## Root cause: Docker single-file bind-mount inode pinning

When you bind-mount a single regular file, Docker resolves it to an inode at mount time and the container kernel pins that inode. If the host process replaces the file atomically (write-temp + rename, which is what every modern auth tool does to avoid corrupting concurrent readers), the inode changes — the path on the host now points to a new inode, but the container's view is still anchored to the old inode (which only exists as long as the container holds it open).

Result: from the container's perspective, the file's *contents* never change after first start. `cat /home/node/.claude/.credentials.json` inside the container returns the bytes that existed at startup, no matter how many times the host CLI writes a new token.

Directory mounts don't have this problem — the directory is the mount point, and lookups inside it re-resolve names every time.

## Root cause: missing OAuth refresh

`loadAnthropicCredentials()` reads `accessToken` and `expiresAt` from the file and caches them. If `expiresAt < now()` it logs `(expired — upstream may reject)` and uses the token anyway. There is no call to `refreshAnthropicToken(refreshToken)`. The host's Claude CLI is the only thing that ever refreshes; if its inode-rotated writes never reach the container (see above), the container can never get a fresh token.

`refreshAnthropicToken` is exported from pi-ai (`@mariozechner/pi-ai`) and was POC'd in this session: passing the refresh token from `~/.claude/.credentials.json` to it returns a new access_token + new refresh_token with `expires_in: 2700` (45 min).

## Architecture decision: container-private credential chain

Standard OAuth allows multiple independent refresh-token chains for one account (this is how multi-device login works). The fix is to give the container its own chain:

1. **Host file** — read-only seed. Container reads it on first start to bootstrap.
2. **Container cache** — writable volume the container owns. Container writes refreshed tokens here. After the first refresh, the container never reads the host file again.
3. **No write-back to host file.** This is intentional — writing to the host file would invalidate the refresh token held in memory by any running `claude` CLI session on the host. The two chains diverge after seeding and stay independent forever.

The seeding moment is the only fragile point. If the host CLI happens to refresh between the container's read and the container's first refresh, the seed token is invalidated. The mitigation is to refresh **immediately** on container start, before the host has a meaningful window to race.

## Architecture decision: lazy refresh, not cron

Drop the `setInterval` cron. Replace with on-demand refresh on the request path, gated by a single-flight mutex so concurrent requests during expiry deduplicate to one network call.

Reasoning:
- It's what the Claude CLI itself does (the `expiresAt` field in the credentials file is the entire mechanism — there's no scheduler in the CLI).
- No idle work. Gateway sits idle → no refresh fires → token expires → next request refreshes.
- One code path handles freshness. No risk of cron silently failing while requests assume tokens are fresh.
- Refresh latency on the first request after expiry is ~200-500ms once per ~45 min — acceptable.

The mutex is mandatory: refresh tokens rotate (each refresh invalidates the previous), so 10 concurrent requests hitting an expired token must all funnel through one refresh, not race.

```ts
let refreshInFlight: Promise<Credentials> | null = null;

async function ensureFresh(): Promise<Credentials> {
  if (Date.now() < creds.expiresAt - SAFETY_BUFFER_MS) return creds;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
```

## Implementation plan

### 1. `deploy/compose.yaml` — directory mount + writable cache volume

Current:
```yaml
volumes:
  - ~/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro
  - ~/.codex/auth.json:/home/node/.codex/auth.json:ro
  - ~/.llm-gateway:/home/node/.llm-gateway
```

New:
```yaml
volumes:
  - ~/.claude:/home/node/host-claude:ro          # directory mount, no inode pinning
  - ~/.codex:/home/node/host-codex:ro            # same fix for Codex
  - ~/.llm-gateway:/home/node/.llm-gateway       # already writable; reuse for cache
```

The `~/.llm-gateway` volume is already writable and persists across container restarts — perfect home for the container's private credential cache. No new volume needed.

### 2. `src/config.ts` — new env vars

```ts
// Read-only seed paths (set by compose to the directory-mounted host paths)
ANTHROPIC_SEED_PATH = env.ANTHROPIC_SEED_PATH ?? `${homedir()}/.claude/.credentials.json`;
CODEX_SEED_PATH    = env.CODEX_SEED_PATH    ?? `${homedir()}/.codex/auth.json`;

// Writable container cache (in the existing ~/.llm-gateway volume)
ANTHROPIC_CACHE_PATH = env.ANTHROPIC_CACHE_PATH ?? `${homedir()}/.llm-gateway/anthropic-credentials.json`;

// Drop CREDENTIAL_REFRESH_INTERVAL_MS — no longer used
```

The existing `ANTHROPIC_CREDENTIALS_PATH` env var is renamed to `ANTHROPIC_SEED_PATH` to make the role explicit. Local dev (no Docker) keeps working: cache path falls back to a sub-file under `~/.llm-gateway/`, which already exists.

### 3. `src/services/auth.ts` — credential cache + lazy refresh + mutex

New shape for Anthropic state:

```ts
interface AnthropicCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}

let anthropicCreds: AnthropicCredentials | undefined;
let anthropicRefreshInFlight: Promise<AnthropicCredentials> | null = null;
```

Bootstrap order (`loadAnthropicCredentials`):
1. If `ANTHROPIC_CACHE_PATH` exists → read it, populate state, **immediately call `ensureAnthropicFresh()`** to refresh once on startup so we have a known-good token before serving requests.
2. Else if `ANTHROPIC_SEED_PATH` exists → read it, populate state, immediately call `ensureAnthropicFresh()` to mint our own chain, write to cache.
3. Else → log unavailable, leave state undefined.

`ensureAnthropicFresh()`:
- If `now < expiresAt - 60_000` → return cached creds.
- If a refresh is in flight → await the existing promise.
- Else → start refresh, store promise in `anthropicRefreshInFlight`, await it, write result to cache file, clear promise.

Refresh body:
```ts
const refreshed = await refreshAnthropicToken(anthropicCreds.refreshToken);
anthropicCreds = {
  accessToken: refreshed.accessToken,
  refreshToken: refreshed.refreshToken,
  expiresAt: refreshed.expiresAt,
};
await writeFile(ANTHROPIC_CACHE_PATH, JSON.stringify({ claudeAiOauth: { ... } }, null, 2));
```

Public API change:
- `getAnthropicKey()` (sync) is **kept** — returns currently-cached `accessToken`. Used by `resolveModel()` which is on the hot path and stays sync.
- `ensureAnthropicFresh()` (async) is **new** — must be called by route handlers before completing a request against an Anthropic model. Refreshes if needed, then `getAnthropicKey()` returns the fresh value.

### 4. `src/routes/chat.ts` (or `src/services/completion.ts`) — call `ensureAnthropicFresh()` on the request path

At the entry of `createCompletion` / `createStreamingCompletion`, after `resolveModel`, if `resolved.provider === "anthropic"`, await `ensureAnthropicFresh()`. The freshened token is then read by re-invoking `getAnthropicKey()` (or by re-resolving). Simplest is to do the freshen call BEFORE `resolveModel` so the resolved model already carries the new key:

```ts
if (modelId.startsWith("claude-")) await ensureAnthropicFresh();  // ~heuristic
const resolved = resolveModel(modelId);
```

Or cleaner: peek the registry to know the provider, then freshen, then resolve. Either is fine — keep it tight.

### 5. `src/index.ts` — drop the cron

Remove the `setInterval(loadCredentials, CREDENTIAL_REFRESH_INTERVAL_MS)` block. `loadCredentials()` is still called once at startup to bootstrap.

### 6. Tests — `tests/auth.test.ts`

Add coverage:
- **Seed path**: cache file absent → reads seed file → on first `ensureAnthropicFresh` calls `refreshAnthropicToken` (mocked) → writes cache file.
- **Cache path**: cache file present → reads cache, ignores seed.
- **Mutex / single-flight**: 10 concurrent `ensureAnthropicFresh` calls when expired → exactly 1 call to `refreshAnthropicToken` (mocked), all 10 resolve to the same token.
- **Skip refresh when fresh**: `expiresAt > now + buffer` → no `refreshAnthropicToken` call.
- **Refresh write-through**: after refresh, the cache file on disk contains the new tokens (use a temp dir).

Mock `refreshAnthropicToken` via vitest's `vi.mock("@mariozechner/pi-ai", ...)`.

## Out of scope (deferred)

- **Codex**: same inode-pinning issue, but Codex JWT lasts 28 days and there's no production breakage right now. The directory-mount fix in step 1 is enough for Codex to keep working — full lazy-refresh via `refreshOpenAICodexToken` (also exported by pi-ai) is a follow-up.
- **Gemini**: already has `refreshGoogleCloudToken`-based refresh, but it writes back to the **host file** (`writeFile(geminiPath, …)`), which is `:ro` mounted and silently fails. The same architectural move (write to a container cache, not the host file) applies. Defer to a follow-up since Gemini is currently working in production (the in-memory refresh succeeds even when the file write doesn't).
- **CREDENTIAL_REFRESH_INTERVAL_MS**: removed in this hotfix. No replacement — lazy is the new model.

## Verification

After deploy:
```bash
# 1. Cache file appears in container after first start
docker exec llm-gateway ls -l /home/node/.llm-gateway/
# expect: anthropic-credentials.json present

# 2. Completion against Anthropic works end-to-end
curl -X POST http://localhost:51277/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"ping"}],"stream":false}' \
  | jq '.choices[0].message.content'
# expect: a real reply, not "Connection error."

# 3. Stop the host claude CLI from running for >1 hour, hit the gateway again
# expect: still works — container is on its own refresh chain now

# 4. Inspect the cache file evolves over time
docker exec llm-gateway cat /home/node/.llm-gateway/anthropic-credentials.json | jq '.claudeAiOauth.expiresAt'
# expect: expiresAt advances every ~45 min as lazy refresh fires
```

Unit tests: `npm test` should pass with the new mutex/seed/cache cases.

## Why this is correct (sanity check)

- The host's `claude` CLI keeps its own `~/.claude/.credentials.json`, refreshing whenever it makes a request. Independent chain, unaffected by the container.
- The container reads that file once at first start, immediately calls `refreshAnthropicToken` to mint its own chain, stores result in `~/.llm-gateway/anthropic-credentials.json` (which is on the writable volume), and never touches the host file again.
- Subsequent requests trigger lazy refresh against the container's own refresh_token, write the new pair back to the cache, serve the request.
- Restarting the container reads the cache (not the seed), and the container's chain continues uninterrupted.
- If the cache is ever wiped (e.g. user deletes `~/.llm-gateway/anthropic-credentials.json`), the container falls back to the seed and re-bootstraps — at which point the next host CLI request will invalidate one of the two, but that's a recoverable one-time stutter, not a steady-state failure mode.
