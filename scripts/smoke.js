import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { storageFromEnv } from "../src/storage.js";
import { startSmtp } from "../src/smtp.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name} ${extra}`);
  }
}

const dir = await mkdtemp(join(tmpdir(), "xin-smoke-"));
const store = storageFromEnv({ XIN_STORAGE: "json", XIN_JSON_PATH: join(dir, "xemails.json") });
const app = createApp({ XIN_ENV: "dev" }, store);
const req = (path, init) => app.request(path, init);

// 1 health
{
  const r = await req("/health");
  const j = await r.json();
  check("health 200 + storage json", r.status === 200 && j.ok && j.storage === "json", JSON.stringify(j));
}

// 2 REST /send
let id1 = "";
{
  const r = await req("/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "dest@example.com", from: "noreply@example.com", subject: "Hello", html: "<h1>Hello</h1>", text: "Hello" }),
  });
  const j = await r.json();
  id1 = j.messageId || "";
  check("POST /send 200 + messageId", r.status === 200 && !!id1, JSON.stringify(j));
  check("messageId XDB default style: 22 numeric digits", /^\d{22}$/.test(id1), id1);
}

// 3 REST /send with no destination -> 400
{
  const r = await req("/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "x" }) });
  check("POST /send with no destination 400", r.status === 400);
}

// 4 SESv2 SendEmail
let id2 = "";
{
  const r = await req("/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Amz-Target": "SimpleEmailServiceV2.SendEmail" },
    body: JSON.stringify({
      FromEmailAddress: "noreply@example.com",
      Destination: { ToAddresses: ["a@example.com"] },
      Content: { Simple: { Subject: { Data: "OTP" }, Body: { Text: { Data: "123456" } } } },
    }),
  });
  const j = await r.json();
  id2 = j.MessageId || "";
  check("SESv2 SendEmail -> MessageId", r.status === 200 && !!id2, JSON.stringify(j));
}

// 5 SESv2 SendBulkEmail
{
  const r = await req("/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Amz-Target": "SimpleEmailServiceV2.SendBulkEmail" },
    body: JSON.stringify({
      FromEmailAddress: "noreply@example.com",
      DefaultContent: { Simple: { Subject: { Data: "Hi" }, Body: { Text: { Data: "hello" } } } },
      BulkEmailEntries: [{ Destination: { ToAddresses: ["b1@x.com"] } }, { Destination: { ToAddresses: ["b2@x.com"] } }],
    }),
  });
  const j = await r.json();
  check("SESv2 SendBulkEmail -> 2 results", r.status === 200 && j.BulkEmailEntryResults?.length === 2, JSON.stringify(j));
}

// 6 list + get + ttl
{
  const r = await req("/messages?limit=10");
  const j = await r.json();
  const now = Math.floor(Date.now() / 1000);
  const ttlOk = (j.items ?? []).every((m) => m.ttl > now && m.ttl <= now + 31 * 86400);
  check("GET /messages list + TTL~30d", r.status === 200 && j.count >= 4 && ttlOk, `count=${j.count}`);
  const g = await req(`/messages/${id1}`);
  const gj = await g.json();
  check("GET /messages/:id 200", g.status === 200 && gj.messageId === id1);
  const nf = await req("/messages/nope");
  check("GET /messages/:id 404", nf.status === 404);
}

// 7 real inbound SMTP (ephemeral port)
{
  const smtp = startSmtp({ port: 0, host: "127.0.0.1", store, onError: () => {} });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      port = smtp.server?.address?.()?.port || 0;
    } catch {
      port = 0;
    }
  }
  if (!port) throw new Error("smtp did not come up");
  const { connect } = await import("node:net");
  async function smtpSend() {
    return new Promise((resolve, reject) => {
      const sock = connect(port, "127.0.0.1");
      let buf = "";
      const queue = [];
      let waiter = null;
      sock.on("data", (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // multi-line SMTP reply: wait for the "NNN " line
          if (/^\d{3} /.test(line) || /^\d{3}-/.test(line) === false) {
            if (/^\d{3} /.test(line)) {
              const w = waiter;
              waiter = null;
              if (w) w(line);
            }
          }
        }
      });
      sock.on("error", reject);
      const cmd = (c, expect) =>
        new Promise((res, rej) => {
          waiter = (line) => {
            if (expect && !line.startsWith(expect)) rej(new Error(`${c} -> ${line}`));
            else res(line);
          };
          sock.write(c + "\r\n");
        });
      (async () => {
        await new Promise((res) => {
          waiter = () => res();
        }); // greeting 220
        await cmd("EHLO xin", "250");
        await cmd("MAIL FROM:<noreply@example.com>", "250");
        await cmd("RCPT TO:<smtp-dest@example.com>", "250");
        await cmd("DATA", "354");
        const data =
          "From: noreply@example.com\r\nTo: smtp-dest@example.com\r\nSubject: via smtp\r\nContent-Type: text/plain; charset=utf-8\r\n\r\ncode 987654\r\n.";
        await cmd(data, "250");
        sock.write("QUIT\r\n");
        setTimeout(() => {
          sock.end();
          resolve();
        }, 200);
      })().catch(reject);
      setTimeout(() => reject(new Error("smtp timeout")), 8000);
    });
  }
  try {
    await smtpSend();
  } catch (e) {
    console.log("smtp dialogue:", String(e.message || e));
  }
  // give the parser time
  await new Promise((r) => setTimeout(r, 800));
  const items = await store.list(50);
  const found = items.find((m) => m.source === "smtp" && String(m.subject).includes("via smtp"));
  check("SMTP :1025 receives and stores", !!found, `smtp items=${items.filter((m) => m.source === "smtp").length}`);
  await new Promise((res) => smtp.close(res));
}

// 8 API Key guard
{
  const guarded = createApp({ XIN_API_KEY: "k123" }, store);
  const denied = await guarded.request("/messages");
  const allowed = await guarded.request("/messages", { headers: { "x-api-key": "k123" } });
  const healthOpen = await guarded.request("/health");
  check("XIN_API_KEY: 403 without key, 200 with key, /health open", denied.status === 403 && allowed.status === 200 && healthOpen.status === 200);
}

await rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
