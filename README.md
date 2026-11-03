# OnMind-XIN — eXpress Inbox / Sink (Amazon SES like)

**OnMind-XIN** is an eXpress Inbox. It sounds like Sink because it catches email messages for proofs of concept and labs.

Companion of [**OnMind-XID**](https://github.com/kaesar/onmind-xid) to use **OTP** by Email. Emulates the **Amazon SES API** for local development and stores every received message (avoid to use real **SES**).

- HTTP API: SESv2 JSON emulation (`SendEmail` / `SendBulkEmail` via `X-Amz-Target`)
  + friendly REST (`POST /send`, `GET /messages`, `GET /messages/:id`)
  + server-rendered HTML inbox (`GET /inbox`, HTTP Basic Auth).
- Inbound SMTP on `0.0.0.0:1025` (what XID sends to Mailpit gets stored here).
- Dual storage: `xemails.json` (local, no extra dependencies) or DynamoDB `xemails`
  (pk `messageId`, TTL `ttl` = now + 30 days).
- Local: Hono + Bun 1.4. Lambda: Node.js 24 pure JS.

## Quick start

```bash
bun install
bun run dev
```

> The service listens on `localhost` on ports `8788` and `1025`, storing in `xemails.json`

```bash
curl -s http://localhost:8788/health
curl -s -X POST http://localhost:8788/send -H 'Content-Type: application/json' \
  -d '{"to":"dest@example.com","from":"noreply@mydomain.com","subject":"Hello","text":"Hello"}'
curl -s http://localhost:8788/messages?limit=5
```

> `html` and `text` are both optional and independent: send either, both, or
> neither — XIN stores them as-is with no coherence check. Email convention is
> to carry the same content in both (`multipart/alternative`), but that is up
> to the sender. Example with both:
>
> ```bash
> curl -s -X POST http://localhost:8788/send -H 'Content-Type: application/json' \
>   -d '{"to":"dest@example.com","from":"noreply@mydomain.com","subject":"Hello","html":"<h1>Hello</h1>","text":"Hello"}'
> ```

## HTML inbox

A simple server-rendered page (no external assets, no client JS) is available at
`GET /inbox`. `GET /inbox/:id` shows one message (plain text, a sandboxed HTML
preview and the raw JSON), and `GET /` redirects there.
The list includes a **Message** column with a one-line body preview (truncated at 50 characters). It works unchanged on Bun and on AWS Lambda, and is the handiest way to read OTP codes sent by [**OnMind-XID**](https://github.com/kaesar/onmind-xid) (XID).

```bash
XIN_INBOX_PASSWORD=secret open http://localhost:8788/inbox
```

### Why Basic Auth (and not XID)

Using XID to protect this page would be **circular**: XID delivers its OTP
email *through* XIN, so reading the code to sign into XIN would require being
signed into XIN already. HTTP Basic Auth breaks that loop and keeps the inbox
independent from XID.

| Var | Usage |
|---|---|
| `XIN_INBOX_PASSWORD` | enables Basic Auth for `/inbox`, **required** when `XIN_ENV=production` (otherwise the page fails closed with 503) |
| `XIN_INBOX_USER` | Basic Auth user (`xin`) |
| `XIN_INBOX_ENABLED` | OnMind flags: `+` enabled / `-` disabled (also `true`/`false`), `-` disables the page (404) |

In local dev (no password) the page is open and displays a warning.
Set `XIN_INBOX_PASSWORD` whenever the service is reachable by others.
The page is **not** guarded by `XIN_API_KEY` (a browser cannot send that header): API clients keep using `x-api-key`, the HTML page uses Basic Auth.

Basic Auth sends the shared credential with every request, so use HTTPS
(API Gateway / Function URL already terminate TLS). It is meant for labs and
proofs of concept: for a long-lived public inbox, put it behind an IP
allowlist, VPN or WAF as well.

## Integration with OnMind-XID

Point XID's SMTP to XIN (`.env`):

```bash
XID_SMTP_HOST=127.0.0.1
XID_SMTP_PORT=1025
```

OTPs sent by XID end up stored in XIN: `GET /messages` –> `text` holds the code.

### Via HTTP (works everywhere, incl. AWS Lambda)

Set `XID_XIN_URL=http://localhost:8788` (plus `XID_XIN_API_KEY` if XIN requires
one): XID then delivers OTPs with `POST /send` instead of SMTP — no SMTP
listener needed on XID's side. Transport order in XID: Cloudflare `send_email`
–> XIN HTTP (if `XID_XIN_URL` is set) –> SMTP –> console fallback (dev).

```mermaid
sequenceDiagram
  participant U as User
  participant XID as OnMind-XID (:8787)
  participant XIN as OnMind-XIN (smtp :1025)
  participant Dev as Developer
  U->>XID: POST /auth/otp/start {email}
  XID->>XIN: SMTP mail (OTP code)
  XIN->>XIN: store in xemails.json
  U->>XID: POST /auth/otp/verify {code}
  Dev->>XIN: GET /messages (read code in dev)
```

## AWS SDK (point to XIN instead of SES)

```js
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
const ses = new SESv2Client({ region: "us-east-1", endpoint: "http://localhost:8788" });
const out = await ses.send(new SendEmailCommand({
  FromEmailAddress: "noreply@mydomain.com",
  Destination: { ToAddresses: ["dest@example.com"] },
  Content: { Simple: { Subject: { Data: "Hello" }, Body: { Text: { Data: "code 123456" } } } },
}));
console.log(out.MessageId); // == messageId in GET /messages/:id
```

## SMTP (swaks)

```bash
swaks --to dest@example.com --from noreply@mydomain.com \
  --server localhost --port 1025 --header-Subject "OTP" --body "code 123456"
curl -s http://localhost:8788/messages?limit=1
```

## Environment variables

| Var | Usage (default) |
|---|---|
| `PORT` | local http (`8788`) |
| `XIN_SMTP_PORT` / `XIN_SMTP_HOST` | smtp (`1025` / `0.0.0.0`) |
| `XIN_STORAGE` | `json` \| `dynamodb` (auto: `dynamodb` if `XIN_TABLE` is set) |
| `XIN_JSON_PATH` | `./xemails.json` |
| `XIN_TABLE` | DynamoDB table (`xemails`) |
| `XIN_DYNAMO_ENDPOINT` | custom endpoint (LocalStack / dynamodb-local / Floci) |
| `XIN_API_KEY` | if set, requires `x-api-key` (except `/health`), in prod sits behind API Gateway + Usage Plan |
| `XIN_INBOX_PASSWORD` | enables HTTP Basic Auth on `/inbox`, required when `XIN_ENV=production` |
| `XIN_INBOX_USER` | Basic Auth user (`xin`) |
| `XIN_INBOX_ENABLED` | `+` enabled / `-` disabled (also `true`/`false`), `-` returns 404 |
| `XIN_CORS_ORIGINS` | CORS allowlist (`*`) |
| `XIN_ENV` | `dev` \| `production` |

## DynamoDB / Lambda

`xemails` table: pk `messageId` (S), TTL attribute `ttl` (N, epoch). Create it with TTL enabled on `ttl` and deploy `src/lambda.handler` (Node.js 24, Function URL or HTTP API Gateway v2). On Lambda there is only the HTTP API (no SMTP).
Use `XIN_TABLE` + `XIN_API_KEY` and protect it with API Key + Usage Plan.
The HTML inbox is at `/inbox` and uses `XIN_INBOX_USER`/`XIN_INBOX_PASSWORD` instead (see above).

> Prefer IaC: `cdk/` deploys all of the above (table + Lambda + HTTP API) —
> see `cdk/ARCHITECTURE.md`. The commands below are the manual equivalent.

```bash
aws dynamodb create-table --table-name xemails \
  --attribute-definitions AttributeName=messageId,AttributeType=S \
  --key-schema AttributeName=messageId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --table-name xemails \
  --time-to-live-specification Enabled=true,AttributeName=ttl
```

## Docker

```bash
docker build -t onmind-xin .
docker run -d --name xin -p 8788:8788 -p 1025:1025 -v /srv/xin:/data onmind-xin
```

## Tests

```bash
bun run smoke
```
