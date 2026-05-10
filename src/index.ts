import { serve } from "@hono/node-server";
import app from "./app.js";
import {
  ANTHROPIC_CACHE_PATH,
  LLM_GATEWAY_PORT,
  LLMGW_DB_PATH,
  VALIDATION_FILE_PATH,
} from "./config.js";
import { importLegacyJson, openDb, setDb } from "./lib/db.js";
import { log } from "./lib/logger.js";
import { loadCredentials } from "./services/auth.js";
import { loadRegistry } from "./services/registry.js";

const db = openDb(LLMGW_DB_PATH);
setDb(db);
importLegacyJson(db, {
  anthropicCachePath: ANTHROPIC_CACHE_PATH,
  validationFilePath: VALIDATION_FILE_PATH,
});

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
