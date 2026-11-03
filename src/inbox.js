import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Server-rendered HTML inbox (no external assets, no client JS), so the same
 * code works on Bun and on AWS Lambda behind API Gateway.
 *
 * Auth is HTTP Basic, deliberately not XID: XID delivers the OTP *through*
 * XIN, so signing into XIN with an XID OTP would require reading XIN first
 * (circular). Basic Auth keeps the inbox independent from XID.
 *
 * Modes:
 *   disabled       XIN_INBOX_ENABLED=false            -> 404
 *   protected      XIN_INBOX_PASSWORD set             -> Basic Auth
 *   misconfigured  XIN_ENV=production, no password    -> 503 (fail closed)
 *   open           dev and no password                -> open + warning
 */

const REALM = "OnMind-XIN Inbox";

export function inboxConfig(env = process.env) {
  const flag = String(env.XIN_INBOX_ENABLED ?? "")
    .trim()
    .toLowerCase();
  // OnMind convention: "+" = true / enabled, "-" = false / disabled (same as XDB)
  // Keep the usual 0/false/no/off forms as aliases. Unset keeps enabled (by default).
  const enabled = !["-", "0", "false", "no", "off"].includes(flag);
  const password = String(env.XIN_INBOX_PASSWORD ?? "");
  const user = String(env.XIN_INBOX_USER || "xin");
  const production = String(env.XIN_ENV || "dev").toLowerCase() === "production";

  let state = "open";
  if (!enabled) state = "disabled";
  else if (password) state = "protected";
  else if (production) state = "misconfigured";
  return { state, user, password, production };
}

export function inboxGuard(cfg) {
  return async (c, next) => {
    if (cfg.state === "disabled") {
      return c.html(
        errorPage("Inbox disabled", "The HTML inbox is disabled (XIN_INBOX_ENABLED)."),
        404
      );
    }
    if (cfg.state === "misconfigured") {
      return c.html(
        errorPage(
          "Inbox not configured",
          "XIN_ENV=production requires XIN_INBOX_PASSWORD for the HTML inbox."
        ),
        503
      );
    }
    if (cfg.state === "open") return next();
    if (!checkBasicAuth(c.req.header("authorization") || "", cfg.user, cfg.password)) {
      c.header("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
      return c.html(errorPage("Authentication required", "This inbox requires HTTP Basic Auth."), 401);
    }
    return next();
  };
}

/** Mount the inbox routes (GET /inbox and GET /inbox/:id). */
export function registerInbox(app, { store, env = process.env }) {
  const cfg = inboxConfig(env);
  const guard = inboxGuard(cfg);

  app.get("/inbox", guard, async (c) => {
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 500));
    const items = await store.list(safeLimit);
    c.header("Cache-Control", "no-store");
    return c.html(listPage({ items, limit: safeLimit, cfg, store, env }));
  });

  app.get("/inbox/:id", guard, async (c) => {
    const item = await store.get(c.req.param("id"));
    c.header("Cache-Control", "no-store");
    if (!item) {
      return c.html(
        errorPage("Message not found", `No stored message with id ${c.req.param("id")}.`, "/inbox"),
        404
      );
    }
    return c.html(messagePage({ item, cfg }));
  });

  return cfg;
}

// ---------------- auth ----------------

// Hash both values before comparing: same-length buffers and no early exit
// on the first differing byte (also hides user/password length).
export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function checkBasicAuth(header, user, password) {
  const match = /^Basic\s+(.+)$/i.exec(String(header).trim());
  if (!match) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  return safeEqual(decoded, `${user}:${password}`);
}

// ---------------- HTML ----------------

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [String(value)];
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function formatShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toISOString().slice(5, 19).replace("T", " ");
}

// One-line body preview for the table: prefer `text`, otherwise strip the
// HTML tags; whitespace collapsed and truncated to `max` characters.
function bodySnippet(item, max = 50) {
  let body = "";
  if (typeof item.text === "string" && item.text.trim() !== "") {
    body = item.text;
  } else if (typeof item.html === "string" && item.html.trim() !== "") {
    body = item.html.replace(/<[^>]*>/g, " ");
  }
  body = body.replace(/\s+/g, " ").trim();
  if (body === "") return "—";
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

const CSS = `
html,body{margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f172a;color:#e5e7eb;min-height:100vh;padding:1.5rem 1rem;box-sizing:border-box}
.wrap{width:100%;max-width:64rem;margin:0 auto}
.card{background:#fff;color:#111827;border-radius:.5rem;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:1.25rem 1.25rem 1rem}
header{display:flex;flex-wrap:wrap;gap:.75rem;align-items:flex-start;justify-content:space-between;margin-bottom:1rem}
h1{font-size:1.25rem;margin:0}
h2{font-size:1rem;margin:1.25rem 0 .5rem}
p{margin:.35rem 0}
.muted{color:#6b7280;font-size:.85rem}
a{color:#1d4ed8;text-decoration:none}
a:hover{text-decoration:underline}
.actions{display:flex;gap:.5rem;flex-wrap:wrap}
.button{display:inline-block;border:1px solid #d1d5db;border-radius:.375rem;padding:.35rem .7rem;font-size:.85rem;background:#f9fafb;color:#111827}
table{width:100%;border-collapse:collapse;font-size:.875rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #e5e7eb;vertical-align:top}
th{background:#f9fafb;font-weight:600;white-space:nowrap}
tbody tr:hover td{background:#f9fafb}
td.num{white-space:nowrap;color:#6b7280;font-variant-numeric:tabular-nums}
td.snippet{max-width:20rem;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:.1rem .5rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.03em}
.warn{background:#fef3c7;border:1px solid #fcd34d;color:#78350f;padding:.6rem .8rem;border-radius:.4rem;font-size:.875rem;margin:0 0 1rem}
.err{background:#fde7e7;border:1px solid #f3b4b4;color:#7f1d1d;padding:.6rem .8rem;border-radius:.4rem}
pre{background:#0f172a;color:#e5e7eb;padding:1rem;border-radius:.4rem;overflow:auto;font-size:.85rem;white-space:pre-wrap;word-break:break-word;margin:.35rem 0}
code{font-size:.85em}
dl.meta{display:grid;grid-template-columns:7rem minmax(0,1fr);gap:.25rem .75rem;font-size:.875rem;margin:0 0 1rem}
dt{color:#6b7280}
dd{margin:0;word-break:break-word}
details{margin:.75rem 0}
summary{cursor:pointer;font-weight:600;font-size:.9rem;margin-bottom:.5rem}
iframe{width:100%;height:26rem;border:1px solid #e5e7eb;border-radius:.4rem;background:#fff;box-sizing:border-box}
.empty{padding:2rem 0;text-align:center;color:#6b7280}
footer{margin-top:1rem;text-align:center;font-size:.75rem;color:#94a3b8}
@media (max-width:640px){.hide-sm{display:none}dl.meta{grid-template-columns:1fr}dt{margin-top:.35rem}}
`;

function pageShell(title, inner) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><div class="wrap"><main class="card">${inner}</main>
<footer>OnMind-XIN · eXpress Inbox</footer></div></body></html>`;
}

function openWarning(cfg) {
  if (cfg.state !== "open") return "";
  return `<p class="warn">Development mode: this inbox is open. Set <code>XIN_INBOX_PASSWORD</code> to protect it.</p>`;
}

function errorPage(title, message, backUrl = "") {
  return pageShell(
    title,
    `<h1>${esc(title)}</h1><p class="err">${esc(message)}</p>` +
      (backUrl ? `<p class="muted"><a href="${esc(backUrl)}">&larr; Back to inbox</a></p>` : "")
  );
}

function listPage({ items, limit, cfg, store, env }) {
  const rows = items
    .map((m) => {
      const id = encodeURIComponent(String(m.messageId || ""));
      const body = bodySnippet(m);
      return `<tr>
<td class="num" title="${esc(m.createdAt)}">${esc(formatShort(m.createdAt))}</td>
<td>${esc(m.from || "—")}</td>
<td class="hide-sm">${esc(asList(m.to).join(", ") || "—")}</td>
<td><a href="/inbox/${id}">${esc(m.subject || "(no subject)")}</a></td>
<td class="snippet" title="${esc(body)}">${esc(body)}</td>
<td><span class="badge">${esc(m.source || "api")}</span></td>
</tr>`;
    })
    .join("");

  const table = items.length
    ? `<table><thead><tr>
<th>Date (UTC)</th><th>From</th><th class="hide-sm">To</th><th>Subject</th><th>Message</th><th>Source</th>
</tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">No messages yet. Send one through the SES API, REST or SMTP.</p>`;

  return pageShell(
    "Inbox · OnMind-XIN",
    `<header>
<div>
<h1>OnMind-XIN <span class="muted">inbox</span></h1>
<p class="muted">storage <code>${esc(store.mode)}</code> · env <code>${esc(env.XIN_ENV || "dev")}</code> · ${items.length} message(s)</p>
</div>
<div class="actions"><a class="button" href="/inbox?limit=${limit}">Refresh</a></div>
</header>
${openWarning(cfg)}
${table}
<p class="muted">Latest ${items.length} message(s), limit ${limit} ·
<a href="/inbox?limit=50">50</a> · <a href="/inbox?limit=100">100</a> · <a href="/inbox?limit=200">200</a></p>`
  );
}

function messagePage({ item, cfg }) {
  const id = String(item.messageId || "");
  const to = asList(item.to).join(", ");
  const cc = asList(item.cc).join(", ");
  const bcc = asList(item.bcc).join(", ");
  const tags = asList(item.tags).join(", ");

  const meta = [
    ["Date", formatDate(item.createdAt)],
    ["From", item.from],
    ["To", to],
    ["Cc", cc],
    ["Bcc", bcc],
    ["Reply-To", item.replyTo],
    ["Source", item.source],
    ["Tags", tags],
    ["Message ID", id],
  ]
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join("");

  const text = typeof item.text === "string" && item.text.trim() !== ""
    ? `<pre>${esc(item.text)}</pre>`
    : `<p class="muted">No plain-text body.</p>`;

  const html = typeof item.html === "string" && item.html.trim() !== ""
    ? `<details><summary>HTML preview (sandboxed)</summary>
<iframe sandbox referrerpolicy="no-referrer" title="HTML preview" srcdoc="${esc(item.html)}"></iframe>
</details>`
    : "";

  return pageShell(
    `${item.subject || "(no subject)"} · OnMind-XIN`,
    `<header>
<div>
<p class="muted"><a href="/inbox">&larr; Back to inbox</a></p>
<h1>${esc(item.subject || "(no subject)")}</h1>
</div>
</header>
${openWarning(cfg)}
<dl class="meta">${meta}</dl>
<h2>Plain text</h2>
${text}
${html}
<details><summary>Raw JSON</summary><pre>${esc(JSON.stringify(item, null, 2))}</pre></details>`
  );
}
