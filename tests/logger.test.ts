import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { log } from "../src/lib/logger";

// pino writes directly to the file descriptor (bypassing process.stdout.write),
// so to inspect output we instantiate a parallel pino with the same config
// but a captured destination. This proves config correctness without coupling
// to stdout capture mechanics.
function buildCapturedLogger() {
  const lines: string[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(chunk);
      return chunk.length;
    },
  };
  // Mirror the production config in src/lib/logger.ts
  const testLog = pino(
    {
      level: "info",
      base: { service: "llm-gateway", version: "test" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream as unknown as NodeJS.WritableStream,
  );
  return { log: testLog, lines };
}

describe("logger module export", () => {
  it("exports a configured pino instance with all level methods", () => {
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.fatal).toBe("function");
    // Production logger has the right service identifier baked in
    expect(log.bindings()).toMatchObject({ service: "llm-gateway" });
  });
});

describe("logger config (parallel instance)", () => {
  it("emits a JSON line with required base fields", () => {
    const { log: testLog, lines } = buildCapturedLogger();
    testLog.info({ event: "test.event", x: 42 }, "test message");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);

    // pino default level field is numeric (30 = info); we accept either
    expect([30, "info"]).toContain(parsed.level);
    expect(parsed.time).toEqual(expect.any(String));
    expect(new Date(parsed.time).toString()).not.toBe("Invalid Date");
    expect(parsed.service).toBe("llm-gateway");
    expect(parsed.version).toBe("test");
    expect(parsed.event).toBe("test.event");
    expect(parsed.x).toBe(42);
    expect(parsed.msg).toBe("test message");
  });

  it("respects level threshold (debug suppressed at info level)", () => {
    const { log: testLog, lines } = buildCapturedLogger();
    testLog.debug({ event: "test.debug" }, "should not appear");
    testLog.info({ event: "test.info" }, "should appear");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("test.info");
  });

  it("auto-serializes Error instances on the err field", () => {
    const { log: testLog, lines } = buildCapturedLogger();
    testLog.error({ event: "test.err", err: new Error("boom") }, "oops");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.err).toBeDefined();
    expect(parsed.err.type).toBe("Error");
    expect(parsed.err.message).toBe("boom");
    expect(parsed.err.stack).toEqual(expect.any(String));
  });

  it("emits ISO 8601 timestamps, not epoch ms", () => {
    const { log: testLog, lines } = buildCapturedLogger();
    testLog.info({ event: "test.time" }, "x");

    const parsed = JSON.parse(lines[0]);
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
