import { AsyncLocalStorage } from "node:async_hooks";
import { type LoggerOptions, pino } from "pino";
import { APP_NAME, APP_VERSION, LOG_LEVEL } from "../config.js";

/**
 * Structured logger for the gateway. Writes one JSON object per line to stdout.
 * Docker captures stdout; Promtail/Loki tail the capture downstream — the app
 * never manages files or transports. See `docs/structured-logging-spec.md`.
 *
 * Field conventions:
 *   - Always present: `time`, `level`, `msg`, `service`, `version`
 *   - `req_id` on every line written while a request runs (see `requestContext`)
 *   - Use `event` for categorical event names (`auth.refresh`, `http.request`, etc.)
 *   - Use `*_ms` for durations, `err` for caught Errors (auto-serialized by pino)
 *   - Use `LOG_LEVEL` env var to bump verbosity at runtime
 */

/** The request being handled; app.ts's request middleware runs each request inside it. */
export const requestContext = new AsyncLocalStorage<{ req_id: string }>();

export const LOG_OPTIONS: LoggerOptions = {
  level: LOG_LEVEL,
  base: { service: APP_NAME, version: APP_VERSION },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Any line logged during a request — a completion's usage or error, a limits fetch, even
  // the usage line a stream writes after the handler returned — carries the request's
  // req_id, so it matches that request's http.request line.
  mixin: () => {
    const ctx = requestContext.getStore();
    return ctx ? { req_id: ctx.req_id } : {};
  },
};

export const log = pino(LOG_OPTIONS);
