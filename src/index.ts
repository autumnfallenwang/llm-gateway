import { serve } from "@hono/node-server";
import app from "./app.js";
import { LLM_GATEWAY_PORT, LLMGW_DB_PATH, VALIDATE_NEW_MODELS_ON_BOOT } from "./config.js";
import { openDb, setDb } from "./lib/db.js";
import { log } from "./lib/logger.js";
import { loadCredentials } from "./services/auth.js";
import { loadRegistry } from "./services/registry.js";
import { validateUnvalidatedModels } from "./services/validation.js";

setDb(openDb(LLMGW_DB_PATH));

await loadCredentials();
await loadRegistry();

log.info({ event: "server.start", port: LLM_GATEWAY_PORT }, "LLM Gateway starting");

serve({ fetch: app.fetch, port: LLM_GATEWAY_PORT });

// Models added since the last full validation would otherwise show `status: "unknown"`
// until someone runs POST /v1/models/validate.
if (VALIDATE_NEW_MODELS_ON_BOOT) {
  validateUnvalidatedModels().catch((err: unknown) => {
    log.warn({ event: "validation.boot_failed", err }, "Validating new models at startup failed");
  });
}
