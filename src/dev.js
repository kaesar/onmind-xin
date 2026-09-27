import { createApp } from "./app.js";
import { storageFromEnv } from "./storage.js";
import { startSmtp } from "./smtp.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const SMTP_PORT = parseInt(process.env.XIN_SMTP_PORT || "1025", 10);
const SMTP_HOST = process.env.XIN_SMTP_HOST || "0.0.0.0";

const store = storageFromEnv(process.env);
const app = createApp(process.env, store);

startSmtp({ port: SMTP_PORT, host: SMTP_HOST, store });

// eslint-disable-next-line no-undef
Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[xin] http :${PORT} (GET /health)`);
console.log(`[xin] smtp ${SMTP_HOST}:${SMTP_PORT}`);
console.log(`[xin] storage ${store.mode}`);
