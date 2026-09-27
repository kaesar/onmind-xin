import { Hono } from "hono";
import { cors } from "hono/cors";
import { newMessageId } from "./ids.js";
import { normalizeRest, parseSendBulkEmail, parseSendEmail } from "./normalize.js";
import { storageFromEnv } from "./storage.js";

export function createApp(env = process.env, storage = null) {
  const app = new Hono();
  const store = storage ?? storageFromEnv(env);
  const API_KEY = env.XIN_API_KEY || "";

  const origins = (env.XIN_CORS_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use("*", cors({ origin: origins.includes("*") ? "*" : origins }));

  // API Key only when configured (prod behind API Gateway; open locally).
  app.use("/send", apiKeyGuard(API_KEY));
  app.use("/messages", apiKeyGuard(API_KEY));
  app.use("/", apiKeyGuard(API_KEY, ["POST"]));

  app.get("/health", (c) => c.json({ ok: true, env: env.XIN_ENV || "dev", storage: store.mode }));

  // SESv2 JSON emulation: POST / with X-Amz-Target SimpleEmailServiceV2.SendEmail|SendBulkEmail
  app.post("/", async (c) => {
    const target = c.req.header("x-amz-target") || "";
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON" }, 400);
    }
    try {
      if (target.includes("SendBulkEmail")) {
        const payloads = parseSendBulkEmail(body);
        const results = [];
        for (const p of payloads) {
          const entry = await store.save({ ...p, _source: "sesv2-bulk" }, newMessageId());
          results.push({ Status: "SUCCESS", MessageId: entry.messageId });
        }
        return c.json({ BulkEmailEntryResults: results });
      }
      // Default: SendEmail
      const payload = parseSendEmail(body);
      const entry = await store.save({ ...payload, _source: "sesv2" }, newMessageId());
      return c.json({ MessageId: entry.messageId });
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  // Friendly REST
  app.post("/send", async (c) => {
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON" }, 400);
    }
    const payload = normalizeRest(body);
    if (payload.to.length + payload.cc.length + payload.bcc.length === 0) {
      return c.json({ message: "Missing destination (to/cc/bcc)" }, 400);
    }
    const entry = await store.save({ ...payload, _source: "rest" }, newMessageId());
    return c.json({ messageId: entry.messageId }, 200);
  });

  app.get("/messages", async (c) => {
    const limit = Math.max(1, Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 500));
    const items = await store.list(limit);
    return c.json({ items, count: items.length, storage: store.mode });
  });

  app.get("/messages/:id", async (c) => {
    const item = await store.get(c.req.param("id"));
    if (!item) return c.json({ message: "Not found" }, 404);
    return c.json(item);
  });

  app.notFound((c) => c.json({ message: "Not found" }, 404));
  return app;
}

function apiKeyGuard(apiKey, methods = null) {
  return async (c, next) => {
    if (!apiKey) return next();
    if (methods && !methods.includes(c.req.method)) return next();
    const got = c.req.header("x-api-key") || "";
    if (got !== apiKey) return c.json({ message: "Forbidden" }, 403);
    return next();
  };
}
