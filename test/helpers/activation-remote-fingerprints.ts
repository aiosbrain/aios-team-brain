import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { credentialFingerprint } from "../../scripts/staging-ops/credential-fingerprint.mjs";

/**
 * Build the synthetic opposite-environment fingerprint document AT TEST RUNTIME.
 *
 * Why not a tracked JSON fixture: `keyConfirmation` is, by construction, a 32-byte HMAC in
 * base64url — `key…: "<43 chars of [0-9A-Za-z_-]>"` with maximal entropy. gitleaks 8.18's
 * `generic-api-key` rule matches any `key…` assignment whose value is ≥10 characters and ≥3.5 bits
 * of Shannon entropy, so all three confirmations matched and the required secret-scan check failed
 * the build.
 *
 * Nothing leaked. Every value was reproducible from the public synthetic comparison key
 * `Buffer.alloc(32, 7)` plus the fixture's own key ID, because the confirmation is derived from the
 * COMPARISON KEY and a public domain/version/keyId string and incorporates no credential input at
 * all — it is designed to travel in fingerprint documents. The finding is a real CI blocker and a
 * false security positive, and the two are recorded separately.
 *
 * The repair keeps the scanner at exactly its current strength: no allowlist, no suppression, no
 * rule change, no encoded-secret workaround, and no weakening of the real key comparison. The
 * document is instead derived from the same synthetic key the tests already configure, so the
 * preflight's comparable-document premise is PRESERVED — writing a repeated-byte placeholder into
 * the JSON would have destroyed it, because `fingerprintsComparable` requires the remote
 * confirmation to match the one the local half mints under the configured key.
 *
 * Callers get a real path on disk, because the code under test reads a FILE: the consumer-side file
 * read is part of what these suites cover and is not stubbed out here.
 */

/** The synthetic comparison key these suites configure. Public, fixed, and not a credential. */
export const SYNTHETIC_COMPARISON_KEY = Buffer.alloc(32, 7);
export const SYNTHETIC_COMPARISON_KEY_BASE64 = SYNTHETIC_COMPARISON_KEY.toString("base64");
export const SYNTHETIC_COMPARISON_KEY_ID = "example-key";

/**
 * The producers join the Neo4j user and password with a NUL, so the pair is unambiguous
 * (`scripts/staging-ops/exporter.mjs`, `importer.mjs`, `activation-preflight.mjs`,
 * `activation-evidence.mjs` all use `${user}\0${password}`). Written as the ESCAPE, never as a raw
 * byte: a literal NUL in a source file makes git classify it as binary, so the diff disappears and
 * the line cannot be edited by textual match.
 */
const NEO4J_CREDENTIAL_SEPARATOR = "\0";

/** Clearly synthetic opposite-environment credential values, distinct per class. */
const REMOTE_CREDENTIALS: ReadonlyArray<readonly [string, string]> = [
  ["auth-secret", "synthetic-production-auth-secret"],
  ["secrets-key", "synthetic-production-secrets-key"],
  [
    "neo4j-credential",
    `synthetic-production-neo4j-user${NEO4J_CREDENTIAL_SEPARATOR}synthetic-production-neo4j-password`,
  ],
];

export interface SyntheticRemoteFingerprints {
  /** Absolute path to the generated document. */
  readonly file: string;
  /** The document itself, for assertions that do not want to re-read it. */
  readonly document: Record<string, unknown>;
  /** Removes the temporary directory. Safe to call more than once. */
  readonly cleanup: () => void;
}

export function writeSyntheticRemoteFingerprints({
  keyId = SYNTHETIC_COMPARISON_KEY_ID,
  comparisonKey = SYNTHETIC_COMPARISON_KEY,
}: { keyId?: string; comparisonKey?: Buffer } = {}): SyntheticRemoteFingerprints {
  const document = Object.fromEntries(
    REMOTE_CREDENTIALS.map(([credentialClass, value]) => [
      credentialClass,
      credentialFingerprint({ credentialClass, value, comparisonKey, keyId }),
    ]),
  );
  const directory = mkdtempSync(path.join(tmpdir(), "aios-activation-fingerprints-"));
  const file = path.join(directory, "activation-remote-fingerprints.json");
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { file, document, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
