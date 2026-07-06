import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for email+password login (postgres backend, no external auth provider).
 * scrypt (Node's built-in, no new dependency — consistent with the rest of this codebase's
 * crypto choices in lib/admin/keys.ts / lib/api/auth.ts) with a random salt per password.
 *
 * Stored format is self-describing so the cost params can change later without a migration:
 *   scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>
 */

const SCRYPT_N = 16384; // CPU/memory cost — OWASP-recommended floor for interactive login
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const MIN_PASSWORD_LENGTH = 10;

export function isPasswordStrongEnough(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

// `async` even though scryptSync blocks: keeps the call sites future-proof if this ever moves to
// a worker thread, and login-rate traffic on a self-hosted team tool doesn't warrant that now.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Verify a password against a stored hash. Timing-safe; never throws on a malformed hash. */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (!salt.length || !expected.length) return false;
  try {
    const derived = scryptSync(password, salt, expected.length, { N: n, r, p });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false; // e.g. corrupt params — treat as non-match, not a crash
  }
}

/** A strong random password for admin-generated accounts — shown once, never logged. */
export function randomPassword(): string {
  // base64url of 18 random bytes → 24 chars, well above MIN_PASSWORD_LENGTH, URL/copy-safe.
  return randomBytes(18).toString("base64url");
}
