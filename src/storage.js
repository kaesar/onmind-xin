import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { nowIso, ttl30d } from "./ids.js";

/**
 * Dual storage (same idea as XID: simple local vs prod binding).
 * - json: xemails.json file with append list (enough for local).
 * - dynamodb: `xemails` table (pk messageId S, TTL attribute `ttl` N in epoch,
 *   full item serialized in `data` S + minimal flat indexes).
 */
export function storageFromEnv(env = process.env) {
  const raw = env.XIN_STORAGE || (env.XIN_TABLE ? "dynamodb" : "json");
  const mode = String(raw).toLowerCase();
  if (mode === "dynamodb") return dynamoStorage(env);
  if (mode === "json") return jsonStorage(env.XIN_JSON_PATH || "./xemails.json");
  // Fail loud: a typo (e.g. XIN_STORAGE=dynamo) must never silently sink
  // production mail into an ephemeral local file.
  throw new Error(`xin: unknown XIN_STORAGE=${JSON.stringify(raw)} (use "json" or "dynamodb")`);
}

function buildEntry(payload, messageId) {
  const createdAt = nowIso();
  return {
    messageId,
    createdAt,
    ttl: ttl30d(),
    source: payload._source || "api",
    ...stripInternal(payload),
  };
}

function stripInternal(p) {
  const { _source, ...rest } = p;
  return rest;
}

// ---- JSON backend ----
function jsonStorage(path) {
  // Serialize read-modify-write: on concurrent two overlapping save would lose message.
  // The chain is kept alive on failure; the failing save still rejects to its caller.
  let chain = Promise.resolve();

  function atomic(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }
  async function readAll() {
    try {
      const raw = await readFile(path, "utf8");
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async function writeAll(arr) {
    await mkdir(dirname(path) === "" ? "." : dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(arr, null, 2) + "\n", "utf8");
  }
  return {
    mode: "json",
    async save(payload, messageId) {
      return atomic(async () => {
        const all = await readAll();
        const entry = buildEntry(payload, messageId);
        all.push(entry);
        await writeAll(all);
        return entry;
      });
    },
    async list(limit = 50) {
      const all = await readAll();
      return all.slice(-Math.max(1, Math.min(limit, 500))).reverse();
    },
    async get(id) {
      const all = await readAll();
      return all.find((m) => m.messageId === id) ?? null;
    },
  };
}

// ---- DynamoDB backend (lazy import: stays out of the local path) ----
function dynamoStorage(env) {
  const table = env.XIN_TABLE || "xemails";
  const endpoint = env.XIN_DYNAMO_ENDPOINT || undefined;
  const region = env.AWS_REGION || "us-east-1";
  let clientPromise = null;
  async function client() {
    if (!clientPromise) {
      clientPromise = import("@aws-sdk/client-dynamodb").then(
        ({ DynamoDBClient }) => new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) })
      );
    }
    return clientPromise;
  }
  return {
    mode: "dynamodb",
    async save(payload, messageId) {
      const entry = buildEntry(payload, messageId);
      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      await db.send(
        new PutItemCommand({
          TableName: table,
          Item: {
            messageId: { S: entry.messageId },
            ttl: { N: String(entry.ttl) },
            createdAt: { S: entry.createdAt },
            from: { S: String(entry.from || "") },
            subject: { S: String(entry.subject || "") },
            source: { S: String(entry.source || "api") },
            data: { S: JSON.stringify(entry) },
          },
        })
      );
      return entry;
    },
    async list(limit = 50) {
      const { ScanCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      const out = await db.send(new ScanCommand({ TableName: table, Limit: Math.max(1, Math.min(limit, 100)) }));
      const items = (out.Items ?? [])
        .map((it) => {
          try {
            return JSON.parse(it.data?.S ?? "{}");
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return items.slice(0, limit);
    },
    async get(id) {
      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      const out = await db.send(new GetItemCommand({ TableName: table, Key: { messageId: { S: id } } }));
      if (!out.Item?.data?.S) return null;
      try {
        return JSON.parse(out.Item.data.S);
      } catch {
        return null;
      }
    },
  };
}
