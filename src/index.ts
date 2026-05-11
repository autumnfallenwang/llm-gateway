import { serve } from "@hono/node-server";
import app from "./app.js";
import { LLM_GATEWAY_PORT, LLMGW_DB_PATH } from "./config.js";
import { openDb, setDb } from "./lib/db.js";
import { log } from "./lib/logger.js";
import { loadCredentials } from "./services/auth.js";
import { loadRegistry } from "./services/registry.js";

setDb(openDb(LLMGW_DB_PATH));

await loadCredentials();
await loadRegistry();

log.info({ event: "server.start", port: LLM_GATEWAY_PORT }, "LLM Gateway starting");

serve({ fetch: app.fetch, port: LLM_GATEWAY_PORT });
