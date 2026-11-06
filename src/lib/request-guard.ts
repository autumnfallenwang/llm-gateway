import type { Context, Next } from "hono";
import { log } from "./logger.js";

/** A Host header's name without its port, lower case; null if it isn't a valid host at all. */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function refuse(c: Context, code: string, message: string, fields: Record<string, string>) {
  log.warn({ event: "request.refused", code, path: c.req.path, ...fields }, "request refused");
  return c.json({ error: { message, type: "invalid_request_error", param: null, code } }, 403);
}

/**
 * The gateway has no login, and it spends the Claude, GPT and DeepSeek allowance of whoever runs it. So it only answers
 * to the names it's served under, and web pages can only call it from its own address:
 *
 * - **Host:** a page can point its own domain at this gateway's IP (DNS rebinding), which makes it same-origin in the
 *   browser. The Host header still carries that domain, so this refuses it.
 * - **Origin:** a browser sends this on a cross-site request. Same-origin is allowed, so the Swagger UI's "Try it out"
 *   keeps working; anything else is refused. Programs send no Origin, so apps aren't affected.
 *
 * `GET /` is exempt: Kubernetes probes send the pod's IP as Host, and it only says the name and version.
 */
export function requestGuard(allowedHosts: readonly string[]) {
  const allowed = new Set(allowedHosts.map((h) => hostnameOf(h)).filter((h) => h !== null));

  return async (c: Context, next: Next) => {
    if (c.req.path === "/") {
      await next();
      return;
    }

    // Only a test's in-process request has none: an HTTP/1.1 server rejects a request without one.
    const host = c.req.header("host");
    if (host !== undefined) {
      const name = hostnameOf(host);
      if (name === null || !allowed.has(name)) {
        return refuse(c, "host_not_allowed", "This gateway doesn't answer to that host name.", {
          host: host.slice(0, 100),
        });
      }
    }

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let sameOrigin = false;
      try {
        sameOrigin = host !== undefined && new URL(origin).host === new URL(`http://${host}`).host;
      } catch {
        // "null" (a sandboxed page), or not a URL at all: not this gateway's own address.
      }
      if (!sameOrigin) {
        return refuse(c, "origin_not_allowed", "Web pages can't call this gateway.", {
          origin: origin.slice(0, 100),
        });
      }
    }

    await next();
  };
}
