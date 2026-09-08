import { createHmac, timingSafeEqual } from "node:crypto";

export const FINGERPRINT_VERSION = "hmac-sha256-v2";
const CONFIRMATION_BYTES = 32;
const CLASSES = new Set(["auth-secret", "secrets-key", "postgres-credential", "neo4j-credential"]);
export const REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES = Object.freeze(["auth-secret", "secrets-key", "neo4j-credential"]);

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
  // The key ID is an operator label, not evidence that two independently configured roles hold the
  // same random comparison key.  This separate, versioned domain binds comparability to the actual
  // high-entropy key material without revealing it or hashing a credential.
  const keyConfirmation = createHmac("sha256", comparisonKey)
    .update(`aios-staging-comparison-key-confirmation\0${FINGERPRINT_VERSION}\0${keyId}\0`, "utf8")
    .digest("base64url");
  return { version: FINGERPRINT_VERSION, keyId, keyConfirmation, credentialClass, mac };
}

function fixedBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === CONFIRMATION_BYTES ? bytes : null;
}

/**
 * Is this a fingerprint at all — right version, a key ID of the shape the minter requires, a known
 * class, and a MAC that decodes to the full 32 bytes?
 *
 * This exists because {@link fingerprintsEqual} answers `false` for a MISSING or MALFORMED input,
 * which a caller comparing environments reads as "these credentials differ" — the exact conclusion
 * an absent document must not produce. Callers that need "incomparable" as its own outcome ask here
 * FIRST, and treat a false as unverified rather than as evidence of separation.
 */
export function fingerprintWellFormed(fp) {
  if (!fp || typeof fp !== "object") return false;
  if (fp.version !== FINGERPRINT_VERSION) return false;
  if (!CLASSES.has(fp.credentialClass)) return false;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(fp.keyId ?? ""))) return false;
  return Boolean(fixedBytes(fp.keyConfirmation) && fixedBytes(fp.mac));
}

/**
 * Two fingerprints may be compared only when both are well formed AND were produced under the same
 * comparison key and class. A different `keyId` yields different MACs for the SAME secret, so
 * comparing across keys manufactures a "they differ" answer out of nothing.
 */
export function fingerprintsComparable(a, b) {
  if (!fingerprintWellFormed(a) || !fingerprintWellFormed(b)) return false;
  if (a.keyId !== b.keyId || a.credentialClass !== b.credentialClass) return false;
  const left = fixedBytes(a.keyConfirmation);
  const right = fixedBytes(b.keyConfirmation);
  return Boolean(left && right && timingSafeEqual(left, right));
}

export function fingerprintsEqual(a, b) {
  if (!fingerprintsComparable(a, b)) return false;
  return timingSafeEqual(fixedBytes(a.mac), fixedBytes(b.mac));
}

export function assertDistinctFingerprints(a, b, label) {
  if (!fingerprintsComparable(a, b)) {
    throw new Error(`${label} fingerprints must be well formed and confirm the same versioned comparison key material and credential class`);
  }
  if (fingerprintsEqual(a, b)) throw new Error(`${label} must differ between production and staging`);
  return true;
}
