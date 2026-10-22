import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrivateFileStore } from "./private-store.mjs";

const ROLES = new Set(["publisher", "source-reader", "rollback-owner"]);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function canonicalObjectId(runId, digest) {
  if (!SAFE.test(String(runId ?? "")) || !/^[0-9a-f]{64}$/.test(String(digest ?? ""))) throw new Error("invalid canonical bundle identity");
  return `${runId}--${digest}`;
}

export function parseCanonicalObjectId(objectId) {
  const match = String(objectId ?? "").match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})--([0-9a-f]{64})$/);
  if (!match) throw new Error("bundle object ID must bind the immutable run ID and SHA-256 digest");
  return { runId: match[1], digest: match[2] };
}

async function bodyBytes(body, maxBytes) {
  if (!body?.transformToByteArray) throw new Error("object-store response body is unavailable");
  const bytes = Buffer.from(await body.transformToByteArray());
  if (bytes.length > maxBytes) throw new Error("private bundle exceeds the configured maximum size");
  return bytes;
}

/** S3-compatible runtime transport. Credentials are intentionally supplied per role/prefix. */
export class S3PrivateStore {
  constructor({ endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, role, maxBytes = 512 * 1024 * 1024, timeoutMs = 30_000, allowInsecure = false, client }) {
    if (!ROLES.has(role)) throw new Error("invalid private store role");
    for (const [name, value] of Object.entries({ endpoint, region, bucket, prefix })) if (!String(value ?? "").trim()) throw new Error(`${name} is required for private object storage`);
    if (!client && (!accessKeyId || !secretAccessKey)) throw new Error("role-specific S3 credentials are required");
    if (!allowInsecure && new URL(endpoint).protocol !== "https:") throw new Error("runtime object storage requires TLS");
    this.client = client ?? new S3Client({
      endpoint, region, forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    this.bucket = bucket;
    this.prefix = String(prefix).replace(/^\/+|\/+$/g, "");
    this.role = role;
    this.maxBytes = Number(maxBytes);
    this.timeoutMs = Number(timeoutMs);
  }
  key(id) {
    if (!SAFE.test(String(id ?? "")) && !/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})--[0-9a-f]{64}$/.test(String(id ?? ""))) throw new Error("invalid immutable bundle ID");
    return `${this.prefix}/${id}.bundle`;
  }
  async send(command) { return this.client.send(command, { abortSignal: AbortSignal.timeout(this.timeoutMs) }); }
  async putImmutable(id, bytes) {
    if (this.role === "source-reader") throw new Error("source bundle identity is read-only");
    if (bytes.length > this.maxBytes) throw new Error("private bundle exceeds the configured maximum size");
    try {
      await this.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(id), Body: bytes, ContentType: "application/octet-stream", IfNoneMatch: "*", Metadata: { sha256: sha256(bytes) } }));
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 412 && error?.name !== "PreconditionFailed") throw error;
      // Canonical keys include the payload digest. A conditional collision at the exact key is
      // therefore a safe retry without granting the publish identity GetObject permission.
      const parsed = parseCanonicalObjectId(id);
      if (parsed.digest !== sha256(bytes)) throw new Error(`immutable bundle ${id} exists with a different digest`);
    }
    return id;
  }
  async read(id) {
    if (this.role === "publisher") throw new Error("publisher identity is write-only");
    const response = await this.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
    return bodyBytes(response.Body, this.maxBytes);
  }
  async verify(id, expectedSha256) { return sha256(await this.read(id)) === expectedSha256; }
  async list(prefix = "") {
    if (this.role === "publisher") throw new Error("publisher identity cannot list source bundles");
    const ids = [];
    let continuationToken;
    do {
      const page = await this.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${this.prefix}/${prefix}`, ContinuationToken: continuationToken }));
      for (const object of page.Contents ?? []) {
        const key = object.Key ?? "";
        if (key.endsWith(".bundle")) ids.push(key.slice(this.prefix.length + 1, -7));
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return ids.sort();
  }
  async writePointer(name, value) {
    if (this.role !== "rollback-owner" || !/^[a-z-]+$/.test(name)) throw new Error("only rollback owner may update a named pointer");
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    await this.send(new PutObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}/pointers/${name}.json`, Body: bytes, ContentType: "application/json" }));
    const readback = await this.readPointer(name);
    if (JSON.stringify(readback) !== JSON.stringify(value)) throw new Error(`pointer ${name} failed durable read-back verification`);
  }
  async readPointer(name) {
    if (this.role !== "rollback-owner" || !/^[a-z-]+$/.test(name)) throw new Error("only rollback owner may read a named pointer");
    const response = await this.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}/pointers/${name}.json` }));
    return JSON.parse((await bodyBytes(response.Body, 1024 * 1024)).toString("utf8"));
  }
  async delete(id) {
    if (this.role !== "rollback-owner") throw new Error("only rollback owner may delete a retained bundle");
    await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
  }
}

function storeConfig(env, scope) {
  const upper = scope.toUpperCase();
  return {
    endpoint: env[`${upper}_S3_ENDPOINT`], region: env[`${upper}_S3_REGION`] ?? "us-east-1",
    bucket: env[`${upper}_S3_BUCKET`], prefix: env[`${upper}_S3_PREFIX`],
    accessKeyId: env[`${upper}_S3_ACCESS_KEY_ID`], secretAccessKey: env[`${upper}_S3_SECRET_ACCESS_KEY`],
    maxBytes: Number(env.STAGING_BUNDLE_MAX_BYTES ?? 512 * 1024 * 1024), timeoutMs: Number(env.STAGING_OBJECT_TIMEOUT_MS ?? 30_000),
  };
}

export function createPrivateStore({ env = process.env, scope, role, client }) {
  if (env.STAGING_OBJECT_STORE === "file") {
    if (env.STAGING_OPS_ALLOW_FILE_STORE !== "1") throw new Error("filesystem bundle transport is allowed only in an explicit local test harness");
    const root = scope === "source" ? env.SOURCE_BUNDLE_DIRECTORY : env.STAGING_ROLLBACK_DIRECTORY;
    return new PrivateFileStore({ root, role });
  }
  if (env.STAGING_OBJECT_STORE !== "s3") throw new Error("STAGING_OBJECT_STORE=s3 is required for runtime transport");
  return new S3PrivateStore({ ...storeConfig(env, scope), role, client, allowInsecure: env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_MAINTENANCE_ADAPTER === "local" });
}
