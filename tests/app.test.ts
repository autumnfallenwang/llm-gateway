import { describe, expect, it } from "vitest";
import app from "../src/app";

describe("Health check", () => {
  it("GET / returns status ok", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.name).toBe("llm-gateway");
  });
});

describe("OpenAPI", () => {
  it("GET /openapi.json returns spec", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBe("3.1.0");
    expect(json.info.title).toBe("LLM Gateway");
  });
});
