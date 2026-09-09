import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packPair, unpackPair, validatePairManifest } from "../scripts/staging-ops/bundle-format.mjs";
import { credentialFingerprint, REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES } from "../scripts/staging-ops/credential-fingerprint.mjs";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(path.join(os.tmpdir(), "pair-format-")); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("immutable pair format", () => {
  it("round-trips binary PG, transformed auth and typed graph with per-file checksums", async () => {
    const a = dir();
    writeFileSync(path.join(a, "postgres.dump"), Buffer.from([0, 255, 8]));
    writeFileSync(path.join(a, "auth_users.csv"), "id,password_hash\n1,\n");
    const graphLedger = "team_id,source_table,source_id,group_id,episode_uuid\nt,items,i,g,e\n";
    writeFileSync(path.join(a, "graph_episodes.csv"), graphLedger);
    const graph = { codecVersion: 1, nodes: [], relationships: [], sanitation: {} };
    const packed = await packPair(a, graph);
    expect(packed.checksums.graphLedger.bytes).toBe(Buffer.byteLength(graphLedger));
    const b = dir();
    expect(await unpackPair(packed.payload, b, packed.checksums)).toEqual(graph);
    expect(readFileSync(path.join(b, "graph_episodes.csv"), "utf8")).toBe(graphLedger);
    const tampered = JSON.parse(packed.payload.toString());
    tampered.graph = Buffer.from("different").toString("base64");
    await expect(unpackPair(Buffer.from(JSON.stringify(tampered)), dir(), packed.checksums)).rejects.toThrow(/checksum/);
  });

  /**
   * A VALID BASELINE FIRST, then one change at a time.
   *
   * The row this replaces asserted `ok === false` on a manifest that was expired AND missing its
   * build identity AND missing every credential fingerprint. Three refusals fire on it, so it
   * certified none of them: delete the expiry check and it stays red on build identity; delete the
   * build check and it stays red on expiry. The baseline below is genuinely acceptable — including
   * real fingerprints minted under a synthetic comparison key — so each row after it changes
   * exactly one fact and asserts exactly the error that fact is supposed to produce.
   */
  const COMPARISON_KEY = Buffer.alloc(32, 3);
  const validManifest = () => ({
    formatVersion: 1,
    graphCodecVersion: 1,
    runId: "run-1",
    captureStartedAt: "2026-01-01T00:00:00Z",
    captureEndedAt: "2026-01-01T00:01:00Z",
    expiresAt: "2026-01-02T00:00:00Z",
    checksums: Object.fromEntries(
      ["postgres", "authUsers", "graphLedger", "graph"].map((n) => [n, { sha256: "a".repeat(64), bytes: 1 }])
    ),
    build: { applicationCommit: "b".repeat(40), schemaFingerprint: "c".repeat(64), migrationSet: { sha256: "d".repeat(64) } },
    credentialFingerprints: Object.fromEntries(
      REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES.map((credentialClass: string) => [
        credentialClass,
        credentialFingerprint({ credentialClass, value: `synthetic-${credentialClass}`, comparisonKey: COMPARISON_KEY, keyId: "bundle-test" }),
      ])
    ),
  });

  // FIXED INSTANT. A validity window compared against the wall clock rots: the baseline would start
  // failing on its own expiry date, for a reason unrelated to anything under test.
  const NOW = Date.parse("2026-01-01T12:00:00Z");

  it("accepts a complete, unexpired source manifest at a fixed instant", () => {
    expect(validatePairManifest(validManifest(), NOW)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    [
      "only the expiry is in the past",
      { expiresAt: "2026-01-01T06:00:00Z" },
      "source bundle expired before it was pinned locally",
    ],
    [
      "only the build identity is absent",
      { build: {} },
      "source build identity is incomplete",
    ],
    [
      "only one required credential fingerprint is absent",
      { credentialFingerprints: { "auth-secret": validManifest().credentialFingerprints["auth-secret"], "secrets-key": validManifest().credentialFingerprints["secrets-key"] } },
      "missing or malformed neo4j-credential credential fingerprint",
    ],
    [
      "only the database mode is an explicit full claim",
      { databaseMode: "full" },
      "source bundle declares database mode full; a source capture is sanitized",
    ],
    [
      "only the database mode is unrecognised",
      { databaseMode: "partial" },
      'unsupported database mode "partial"',
    ],
  ])("refuses when %s", (_name, changed, reason) => {
    const result = validatePairManifest({ ...validManifest(), ...changed }, NOW);
    expect(result.errors).toEqual([reason]);
    expect(result.ok).toBe(false);
  });

  /**
   * M3 — `databaseMode` decides whether a restored pair keeps its own captured credentials, so an
   * unvalidated value is a rollback-integrity hole. The baseline above is a source manifest with the
   * field ABSENT, which is what the current exporter emits and which means sanitized; the rows here
   * cover the three remaining shapes on both sides of the source/rollback boundary.
   */
  describe("declared database mode", () => {
    // A rollback envelope is importer-owned: it carries only the two stores it captured, and its
    // credential fingerprints are staging's own rather than production evidence.
    const validRollbackManifest = () => ({
      ...validManifest(),
      kind: "staging-rollback",
      checksums: Object.fromEntries(["postgres", "graph"].map((n) => [n, { sha256: "a".repeat(64), bytes: 1 }])),
      credentialFingerprints: undefined,
    });

    it("accepts an explicitly sanitized SOURCE bundle", () => {
      expect(validatePairManifest({ ...validManifest(), databaseMode: "sanitized" }, NOW)).toEqual({ ok: true, errors: [] });
    });

    it("accepts a FULL importer-owned rollback checkpoint", () => {
      // The one legitimate producer of `full`: a bootstrap capture of staging's own database, sealed
      // and opened under the importer's rollback key.
      expect(validatePairManifest({ ...validRollbackManifest(), databaseMode: "full" }, NOW, { allowRollback: true }))
        .toEqual({ ok: true, errors: [] });
    });

    it("keeps ABSENT-mode rollback compatibility, and reads it as sanitized rather than full", () => {
      const absent = validatePairManifest(validRollbackManifest(), NOW, { allowRollback: true });
      expect(absent, "an existing rollback envelope with no declared mode stopped opening").toEqual({ ok: true, errors: [] });
      // Compatibility is not a promotion: nothing about the absent case may be read as `full`. That
      // is what the seal decides, and `sealReadyRollback` writes `sanitized` for it.
      expect(validRollbackManifest().databaseMode).toBeUndefined();
    });

    it("refuses an unrecognised mode on a rollback envelope too", () => {
      const result = validatePairManifest({ ...validRollbackManifest(), databaseMode: "whole" }, NOW, { allowRollback: true });
      expect(result.errors).toEqual(['unsupported database mode "whole"']);
    });
  });
});
