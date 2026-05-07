import { serve } from "@hono/node-server";
import app from "./app.js";
import { LLM_GATEWAY_PORT } from "./config.js";
import { loadCredentials } from "./services/auth.js";
import { loadRegistry } from "./services/registry.js";

await loadCredentials();
await loadRegistry();

// biome-ignore lint/suspicious/noConsole: intentional startup log
console.log(`LLM Gateway starting on http://localhost:${LLM_GATEWAY_PORT}`);
// biome-ignore lint/suspicious/noConsole: intentional startup log
console.log(`Swagger UI: http://localhost:${LLM_GATEWAY_PORT}/docs`);

serve({ fetch: app.fetch, port: LLM_GATEWAY_PORT });
