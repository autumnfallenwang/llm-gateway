import { serve } from "@hono/node-server";
import app from "./app.js";
import { LLM_GATEWAY_PORT } from "./config.js";
import { log } from "./lib/logger.js";
import { loadCredentials } from "./services/auth.js";
import { loadRegistry } from "./services/registry.js";

await loadCredentials();
await loadRegistry();

log.info(
  {
    event: "server.start",
    port: LLM_GATEWAY_PORT,
    docs_url: `http://localhost:${LLM_GATEWAY_PORT}/docs`,
  },
  "LLM Gateway starting",
);

serve({ fetch: app.fetch, port: LLM_GATEWAY_PORT });
