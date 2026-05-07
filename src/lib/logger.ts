import { pino } from "pino";
import { APP_NAME, APP_VERSION, LOG_LEVEL } from "../config.js";

/**
 * Structured logger for the gateway. Writes one JSON object per line to stdout.
 * Docker captures stdout; Promtail/Loki tail the capture downstream — the app
 * never manages files or transports. See `docs/structured-logging-spec.md`.
 *
 * Field conventions:
 *   - Always present: `time`, `level`, `msg`, `service`, `version`
 *   - Use `event` for categorical event names (`auth.refresh`, `http.request`, etc.)
 *   - Use `*_ms` for durations, `err` for caught Errors (auto-serialized by pino)
 *   - Use `LOG_LEVEL` env var to bump verbosity at runtime
 */
export const log = pino({
  level: LOG_LEVEL,
  base: { service: APP_NAME, version: APP_VERSION },
  timestamp: pino.stdTimeFunctions.isoTime,
});
