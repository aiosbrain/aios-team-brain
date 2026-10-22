#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

const root = process.env.LOCAL_OBJECT_STORE_ROOT ?? "/tmp/aios-object-store";
const bucket = process.env.LOCAL_OBJECT_STORE_BUCKET;
const policies = JSON.parse(process.env.LOCAL_OBJECT_STORE_POLICIES_JSON ?? "{}");
if (!bucket || !Object.keys(policies).length) throw new Error("local object store bucket and policies are required");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const awsEncode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function reply(res, status, body = "", type = "application/xml") {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function signedIdentity(req, url) {
  const raw = String(req.headers.authorization ?? "");
  const algorithm = raw.split(" ", 1)[0];
  const credential = raw.match(/Credential=([^,]+)/)?.[1];
  const signedHeaders = raw.match(/SignedHeaders=([^,]+)/)?.[1];
  const signature = raw.match(/Signature=([0-9a-f]{64})/)?.[1];
  if (algorithm !== "AWS4-HMAC-SHA256" || !credential || !signedHeaders || !signature) return null;
  const [accessKey, date, region, service, terminal] = credential.split("/");
  const policy = policies[accessKey];
  const timestamp = String(req.headers["x-amz-date"] ?? "");
  if (!policy?.secret || date !== timestamp.slice(0, 8) || region !== "us-east-1" || service !== "s3" || terminal !== "aws4_request") return null;
  const instant = Date.parse(timestamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
  if (!Number.isFinite(instant) || Math.abs(Date.now() - instant) > 15 * 60_000) return null;
  const names = signedHeaders.split(";");
  const canonicalHeaders = names.map((name) => `${name}:${String(req.headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  if (names.some((name) => req.headers[name] == null)) return null;
  const query = [...url.searchParams.entries()].map(([key, value]) => [awsEncode(key), awsEncode(value)]).sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv)).map(([key, value]) => `${key}=${value}`).join("&");
  const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
  const canonical = [req.method, url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/${terminal}`;
  const stringToSign = `${algorithm}\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const dateKey = hmac(`AWS4${policy.secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, terminal);
  const expected = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) ? { accessKey, policy, payloadHash } : null;
}

function authorize(identity, operation, key) {
  return Boolean(identity?.policy.operations?.includes(operation) && identity.policy.prefixes?.some((prefix) => key.startsWith(prefix)));
}

function safeObjectPath(key) {
  if (!key || key.includes("\0") || key.split("/").some((part) => part === "..")) throw new Error("invalid object key");
  return path.join(root, key);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://object-store");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.shift() !== bucket) return reply(res, 404, "<Error><Code>NoSuchBucket</Code></Error>");
    const key = decodeURIComponent(parts.join("/"));
    const identity = signedIdentity(req, url);
    if (!identity) return reply(res, 403, "<Error><Code>AccessDenied</Code><Message>signature verification failed</Message></Error>");
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!authorize(identity, "list", prefix)) return reply(res, 403, "<Error><Code>AccessDenied</Code></Error>");
      const files = await readdir(root, { recursive: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
      const keys = files.map(String).filter((name) => !name.endsWith(".tmp") && name.startsWith(prefix)).sort();
      const contents = keys.map((name) => `<Contents><Key>${xmlEscape(name)}</Key><Size>0</Size></Contents>`).join("");
      return reply(res, 200, `<ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    if (req.method === "PUT") {
      if (!authorize(identity, "put", key)) return reply(res, 403, "<Error><Code>AccessDenied</Code></Error>");
      const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
      if (!/^[0-9a-f]{64}$/.test(identity.payloadHash) || hash(bytes) !== identity.payloadHash) return reply(res, 403, "<Error><Code>AccessDenied</Code><Message>payload digest mismatch</Message></Error>");
      const filename = safeObjectPath(key); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const handle = await open(filename, req.headers["if-none-match"] === "*" ? "wx" : "w", 0o600).catch((error) => error?.code === "EEXIST" ? null : Promise.reject(error));
      if (!handle) return reply(res, 412, "<Error><Code>PreconditionFailed</Code></Error>");
      try { await handle.write(bytes); await handle.sync(); } finally { await handle.close(); }
      return reply(res, 200, "", "application/octet-stream");
    }
    if (req.method === "GET") {
      if (!authorize(identity, "get", key)) return reply(res, 403, "<Error><Code>AccessDenied</Code></Error>");
      const bytes = await readFile(safeObjectPath(key)).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!bytes) return reply(res, 404, "<Error><Code>NoSuchKey</Code></Error>");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }); res.end(bytes); return;
    }
    if (req.method === "DELETE") {
      if (!authorize(identity, "delete", key)) return reply(res, 403, "<Error><Code>AccessDenied</Code></Error>");
      await unlink(safeObjectPath(key)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      return reply(res, 204, "", "application/octet-stream");
    }
    return reply(res, 405, "<Error><Code>MethodNotAllowed</Code></Error>");
  } catch {
    return reply(res, 500, "<Error><Code>InternalError</Code></Error>");
  }
});

server.listen(Number(process.env.PORT ?? 9000), "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
