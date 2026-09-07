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
});
