import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Symmetric encryption for connector secrets at rest (Integrations settings). AES-256-GCM:
 * authenticated, so tampering with the stored ciphertext is detected on decrypt. The key
 * comes from the server-only `SECRETS_KEY` env (32 bytes, base64 or hex) — never the client.
 * Stored blob layout (base64): iv(12) || authTag(16) || ciphertext.
 */

const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

/** Resolve the 32-byte key from `SECRETS_KEY` (base64 or hex). Throws if unusable. */
export function secretsKey(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (!raw) {
    throw new Error("SECRETS_KEY is required to store/read connector secrets (32 bytes, base64 or hex).");
  }
  const key = decodeKey(raw);
  if (key.length !== KEY_LEN) {
    throw new Error(`SECRETS_KEY must decode to ${KEY_LEN} bytes (got ${key.length}).`);
  }
  return key;
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  return Buffer.from(trimmed, "base64");
}

/** Encrypt plaintext → base64(iv|tag|ciphertext). `key` defaults to SECRETS_KEY. */
export function encryptSecret(plaintext: string, key: Buffer = secretsKey()): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a base64(iv|tag|ciphertext) blob. Throws on a bad key or tampered data. */
export function decryptSecret(blob: string, key: Buffer = secretsKey()): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short / malformed");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Generate a fresh base64 SECRETS_KEY (for provisioning a deployment). */
export function generateSecretsKey(): string {
  return randomBytes(KEY_LEN).toString("base64");
}
