import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";

const app = new OpenAPIHono();

app.use("/*", cors());

// OpenAPI spec
app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "LLM Gateway",
    version: "0.1.0",
    description: "Self-hosted OpenAI-compatible API gateway for multiple LLM backends",
  },
});

// Swagger UI
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// Health check
app.get("/", (c) => c.json({ status: "ok", name: "llm-gateway", version: "0.1.0" }));

export default app;
