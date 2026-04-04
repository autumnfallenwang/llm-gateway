import { serve } from "@hono/node-server";
import app from "./app.js";
import { CREDENTIAL_REFRESH_INTERVAL_MS, LLM_GATEWAY_PORT } from "./config.js";
import { loadCredentials } from "./services/auth.js";
import { loadRegistry } from "./services/registry.js";

await loadCredentials();
await loadRegistry();

// biome-ignore lint/suspicious/noConsole: intentional startup log
console.log(`LLM Gateway starting on http://localhost:${LLM_GATEWAY_PORT}`);
// biome-ignore lint/suspicious/noConsole: intentional startup log
console.log(`Swagger UI: http://localhost:${LLM_GATEWAY_PORT}/docs`);

serve({ fetch: app.fetch, port: LLM_GATEWAY_PORT });

// Periodically re-read credentials from disk to pick up refreshed tokens
setInterval(async () => {
  // biome-ignore lint/suspicious/noConsole: intentional scheduled log
  console.log("[auth] Scheduled credential refresh...");
  await loadCredentials();
}, CREDENTIAL_REFRESH_INTERVAL_MS);
