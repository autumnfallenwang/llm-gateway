import { serve } from "@hono/node-server";
import app from "./app.js";
import { loadCredentials } from "./services/auth.js";
import { loadRegistry } from "./services/registry.js";

const port = Number(process.env.PORT ?? 8080);

await loadCredentials();
await loadRegistry();

// biome-ignore lint/suspicious/noConsole: intentional startup log
console.log(`LLM Gateway starting on http://localhost:${port}`);
// biome-ignore lint/suspicious/noConsole: intentional startup log
console.log(`Swagger UI: http://localhost:${port}/docs`);

serve({ fetch: app.fetch, port });
