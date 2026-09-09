import { describe, expect, it } from "vitest";
import { credentialFingerprint, fingerprintsEqual, assertDistinctFingerprints } from "../scripts/staging-ops/credential-fingerprint.mjs";

describe("ops-only credential comparison", () => {
  const key = Buffer.alloc(32, 7);
  it("normalizes bytes identically and domain-separates credential classes", () => {
    const a = credentialFingerprint({ credentialClass: "auth-secret", value: "caf\u00e9", comparisonKey: key, keyId: "2026-01" });
    const b = credentialFingerprint({ credentialClass: "auth-secret", value: "cafe\u0301", comparisonKey: key, keyId: "2026-01" });
    const c = credentialFingerprint({ credentialClass: "secrets-key", value: "caf\u00e9", comparisonKey: key, keyId: "2026-01" });
    expect(fingerprintsEqual(a, b)).toBe(true);
    expect(fingerprintsEqual(a, c)).toBe(false);
    expect(JSON.stringify(a)).not.toContain("caf");
  });

  it("requires versioned key identity and refuses matching environment credentials", () => {
    expect(() => credentialFingerprint({ credentialClass: "neo4j-credential", value: "x", comparisonKey: Buffer.alloc(2), keyId: "v1" })).toThrow(/32/);
    const a = credentialFingerprint({ credentialClass: "neo4j-credential", value: "same", comparisonKey: key, keyId: "v1" });
    expect(() => assertDistinctFingerprints(a, a, "Neo4j credential")).toThrow(/differ/);
  });

  it("requires comparability before treating unequal MAC text as credential separation", () => {
    const source = credentialFingerprint({ credentialClass: "auth-secret", value: "same", comparisonKey: key, keyId: "source-key" });
    const target = credentialFingerprint({ credentialClass: "auth-secret", value: "same", comparisonKey: key, keyId: "target-key" });
    expect(() => assertDistinctFingerprints(source, target, "AUTH_SECRET")).toThrow(/same versioned comparison key material/);
    expect(() => assertDistinctFingerprints(undefined, target, "AUTH_SECRET")).toThrow(/well formed/);
    expect(() => assertDistinctFingerprints({ ...source, mac: "malformed" }, target, "AUTH_SECRET")).toThrow(/well formed/);
  });

  it("refuses equal key IDs backed by different actual comparison keys", () => {
    const source = credentialFingerprint({ credentialClass: "auth-secret", value: "same", comparisonKey: Buffer.alloc(32, 1), keyId: "ops-v2" });
    const target = credentialFingerprint({ credentialClass: "auth-secret", value: "same", comparisonKey: Buffer.alloc(32, 2), keyId: "ops-v2" });
    expect(source.keyConfirmation).not.toBe(target.keyConfirmation);
    expect(() => assertDistinctFingerprints(source, target, "AUTH_SECRET")).toThrow(/key material/);
  });

  it.each(["missing", "malformed"])("refuses a %s key-material confirmation", (kind) => {
    const source = credentialFingerprint({ credentialClass: "auth-secret", value: "prod", comparisonKey: key, keyId: "ops-v2" });
    const target = credentialFingerprint({ credentialClass: "auth-secret", value: "staging", comparisonKey: key, keyId: "ops-v2" });
    const changed = { ...source, keyConfirmation: kind === "missing" ? undefined : "not-fixed-bytes" };
    expect(() => assertDistinctFingerprints(changed, target, "AUTH_SECRET")).toThrow(/well formed/);
  });

  it("accepts distinct credentials only under the same comparison key identity", () => {
    const source = credentialFingerprint({ credentialClass: "secrets-key", value: "source", comparisonKey: key, keyId: "shared-key" });
    const target = credentialFingerprint({ credentialClass: "secrets-key", value: "target", comparisonKey: key, keyId: "shared-key" });
    expect(assertDistinctFingerprints(source, target, "SECRETS_KEY")).toBe(true);
  });
});
