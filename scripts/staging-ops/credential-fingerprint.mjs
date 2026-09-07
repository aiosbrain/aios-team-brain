import { createHmac, timingSafeEqual } from "node:crypto";

export const FINGERPRINT_VERSION = "hmac-sha256-v1";
const CLASSES = new Set(["auth-secret", "secrets-key", "postgres-credential", "neo4j-credential"]);

function normalize(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== "string") throw new Error("credential fingerprint input must be bytes or a string");
  return Buffer.from(value.normalize("NFC"), "utf8");
}

export function credentialFingerprint({ credentialClass, value, comparisonKey, keyId }) {
  if (!CLASSES.has(credentialClass)) throw new Error(`unsupported credential fingerprint class ${credentialClass}`);
  if (!Buffer.isBuffer(comparisonKey) || comparisonKey.length < 32) throw new Error("comparison key must contain at least 32 random bytes");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(keyId ?? ""))) throw new Error("versioned comparison key ID is required");
  const bytes = normalize(value);
  const mac = createHmac("sha256", comparisonKey)
    .update(`aios-staging-credential\0${FINGERPRINT_VERSION}\0${keyId}\0${credentialClass}\0`, "utf8")
    .update(bytes)
    .digest("base64url");
  return { version: FINGERPRINT_VERSION, keyId, credentialClass, mac };
}

export function fingerprintsEqual(a, b) {
  if (!a || !b || a.version !== b.version || a.keyId !== b.keyId || a.credentialClass !== b.credentialClass) return false;
  const left = Buffer.from(String(a.mac ?? ""), "base64url");
  const right = Buffer.from(String(b.mac ?? ""), "base64url");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

export function assertDistinctFingerprints(a, b, label) {
  if (fingerprintsEqual(a, b)) throw new Error(`${label} must differ between production and staging`);
}
