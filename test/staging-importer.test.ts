import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedEncryptedBundle, openSignedEncryptedBundle, rollbackOpeningProvenance } from "../scripts/staging-ops/bundle-crypto.mjs";
import { assertReplayableGraph, compareEnvironmentCredentials, installObject, verifyAndPinSourceBundle, verifyInstalledPair, waitForImportedBoot } from "../scripts/staging-ops/importer.mjs";
import { PrivateFileStore } from "../scripts/staging-ops/private-store.mjs";
import { credentialFingerprint } from "../scripts/staging-ops/credential-fingerprint.mjs";
import { validatePairManifest } from "../scripts/staging-ops/bundle-format.mjs";
import { loaderCapabilityIdentity, schemaFingerprintDigest } from "../scripts/staging-ops/build-identity.mjs";
import { fingerprint } from "../scripts/schema-fingerprint.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("staging importer bundle boundary", () => {
  it("accepts the measured legacy bootstrap mode without requiring graph readiness", async () => {
    const maintenance = { readDeployment: async () => ({ status: "SUCCESS" }) };
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, mode: "legacy-pg-only", commit: "a".repeat(40) }));
    await expect(waitForImportedBoot({ maintenance, deploymentId: "bootstrap", commit: "a".repeat(40), origin: "http://staging.test", token: "t".repeat(32), mode: "legacy-pg-only", fetchImpl, timeoutMs: 10, sleep: async () => {} })).resolves.toBe(true);
  });

  it("verifies publisher signature/decryption/expiry before privately pinning", async () => {
    const sign = generateKeyPairSync("ed25519"); const enc = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "src-")); const rollbackRoot = mkdtempSync(path.join(os.tmpdir(), "rb-")); roots.push(sourceRoot, rollbackRoot);
    const comparisonKey = Buffer.alloc(32, 9);
    const credentialFingerprints = Object.fromEntries([
      ["auth-secret", "auth"], ["secrets-key", "secrets"], ["neo4j-credential", "neo4j"],
    ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: "shared-key" })]));
    const manifest = { formatVersion: 1, graphCodecVersion: 1, runId: "run-1", captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), checksums: Object.fromEntries(["postgres", "authUsers", "graphLedger", "graph"].map((n) => [n, { sha256: "a".repeat(64) }])), build: { applicationCommit: "b".repeat(40), schemaFingerprint: "c".repeat(64), migrationSet: { sha256: "d".repeat(64) } }, credentialFingerprints };
    const bundle = createSignedEncryptedBundle({ payload: Buffer.from("payload"), manifest, exporterSigningPrivateKey: sign.privateKey, importerEncryptionPublicKey: enc.publicKey });
    const bytes = Buffer.from(JSON.stringify(bundle));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const objectId = `run-1--${digest}`;
    const source = new PrivateFileStore({ root: sourceRoot, role: "publisher" }); await source.putImmutable(objectId, bytes);
    const opened = await verifyAndPinSourceBundle({ objectId, sourceStore: new PrivateFileStore({ root: sourceRoot, role: "source-reader" }), rollbackStore: new PrivateFileStore({ root: rollbackRoot, role: "rollback-owner" }), env: { EXPORTER_SIGNING_PUBLIC_KEY: sign.publicKey, IMPORTER_ENCRYPTION_PRIVATE_KEY: enc.privateKey } });
    expect(opened.manifest.runId).toBe("run-1");
    expect((await new PrivateFileStore({ root: rollbackRoot, role: "rollback-owner" }).read(objectId)).length).toBeGreaterThan(0);
  });

  it("refuses missing/malformed production credential proof at signed-manifest admission", () => {
    const comparisonKey = Buffer.alloc(32, 9);
    const fingerprints = Object.fromEntries([
      ["auth-secret", "auth"], ["secrets-key", "secrets"], ["neo4j-credential", "neo4j"],
    ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: "shared-key" })]));
    const manifest = {
      formatVersion: 1, graphCodecVersion: 1, runId: "run-2",
      captureStartedAt: "2026-09-08T00:00:00Z", captureEndedAt: "2026-09-08T00:00:01Z",
      expiresAt: "2099-01-01T00:00:00Z",
      checksums: Object.fromEntries(["postgres", "authUsers", "graphLedger", "graph"].map((name) => [name, { sha256: "a".repeat(64) }])),
      build: { applicationCommit: "b".repeat(40), schemaFingerprint: "c".repeat(64), migrationSet: { sha256: "d".repeat(64) } },
      credentialFingerprints: fingerprints,
    };
    expect(validatePairManifest(manifest).ok).toBe(true);
    expect(validatePairManifest({ ...manifest, credentialFingerprints: {} }).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/auth-secret/), expect.stringMatching(/secrets-key/), expect.stringMatching(/neo4j-credential/),
    ]));
    expect(validatePairManifest({ ...manifest, credentialFingerprints: { ...fingerprints, "auth-secret": { ...fingerprints["auth-secret"], mac: "bad" } } }).ok).toBe(false);

    // Staging-owned rollback archives intentionally contain staging credentials and are not forced
    // through source-vs-target separation.
    expect(validatePairManifest({ ...manifest, kind: "staging-rollback", checksums: { postgres: manifest.checksums.postgres, graph: manifest.checksums.graph }, credentialFingerprints: undefined }, Date.now(), { allowRollback: true }).ok).toBe(true);
  });

  it("refuses identical secrets minted under mismatched key IDs before lifecycle admission", () => {
    const comparisonKey = Buffer.alloc(32, 4);
    const source = Object.fromEntries([
      ["auth-secret", "same-auth"], ["secrets-key", "same-secrets"], ["neo4j-credential", "neo4j\0same"],
    ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: "source-key" })]));
    const env = {
      STAGING_COMPARISON_KEY_BASE64: comparisonKey.toString("base64"), STAGING_COMPARISON_KEY_ID: "target-key",
      AUTH_SECRET: "same-auth", SECRETS_KEY: "same-secrets", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "same",
    } as NodeJS.ProcessEnv;
    expect(() => compareEnvironmentCredentials({ credentialFingerprints: source }, env)).toThrow(/same versioned comparison key material/);
  });

  it("refuses a genuinely signed source minted with different comparison material before lifecycle admission", async () => {
    const sign = generateKeyPairSync("ed25519"); const enc = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "src-key-skew-")); const rollbackRoot = mkdtempSync(path.join(os.tmpdir(), "rb-key-skew-")); roots.push(sourceRoot, rollbackRoot);
    const sourceKey = Buffer.alloc(32, 1); const targetKey = Buffer.alloc(32, 2);
    const credentials = [["auth-secret", "same-auth"], ["secrets-key", "same-secrets"], ["neo4j-credential", "neo4j\0same"]] as const;
    const credentialFingerprints = Object.fromEntries(credentials.map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey: sourceKey, keyId: "same-id" })]));
    const now = new Date();
    const manifest = {
      formatVersion: 1, graphCodecVersion: 1, runId: "key-skew", captureStartedAt: now.toISOString(), captureEndedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      checksums: Object.fromEntries(["postgres", "authUsers", "graphLedger", "graph"].map((name) => [name, { sha256: "a".repeat(64) }])),
      build: { ...loaderCapabilityIdentity(), applicationCommit: "b".repeat(40), schemaFingerprint: "c".repeat(64) }, credentialFingerprints,
    };
    const bytes = Buffer.from(JSON.stringify(createSignedEncryptedBundle({ payload: Buffer.from("payload"), manifest, exporterSigningPrivateKey: sign.privateKey, importerEncryptionPublicKey: enc.publicKey })));
    const digest = createHash("sha256").update(bytes).digest("hex"); const objectId = `key-skew--${digest}`;
    const publisher = new PrivateFileStore({ root: sourceRoot, role: "publisher" }); await publisher.putImmutable(objectId, bytes);
    const acquire = vi.fn(async () => true);
    await expect(installObject({
      client: {}, objectId, sourceStore: new PrivateFileStore({ root: sourceRoot, role: "source-reader" }), rollbackStore: new PrivateFileStore({ root: rollbackRoot, role: "rollback-owner" }), maintenance: {},
      env: { EXPORTER_SIGNING_PUBLIC_KEY: sign.publicKey, IMPORTER_ENCRYPTION_PRIVATE_KEY: enc.privateKey, STAGING_COMPARISON_KEY_BASE64: targetKey.toString("base64"), STAGING_COMPARISON_KEY_ID: "same-id", AUTH_SECRET: "same-auth", SECRETS_KEY: "same-secrets", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "same" } as unknown as NodeJS.ProcessEnv,
      operations: { acquireCoordinatorLock: acquire },
    })).rejects.toThrow(/key material/);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("admits distinct same-key-ID environment credentials", () => {
    const comparisonKey = Buffer.alloc(32, 4);
    const source = Object.fromEntries([
      ["auth-secret", "prod-auth"], ["secrets-key", "prod-secrets"], ["neo4j-credential", "neo4j\0prod"],
    ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: "shared-key" })]));
    const env = {
      STAGING_COMPARISON_KEY_BASE64: comparisonKey.toString("base64"), STAGING_COMPARISON_KEY_ID: "shared-key",
      AUTH_SECRET: "staging-auth", SECRETS_KEY: "staging-secrets", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "staging",
    } as NodeJS.ProcessEnv;
    expect(compareEnvironmentCredentials({ credentialFingerprints: source }, env)).toBe(true);
  });
});

describe("M2 — the bootstrap checkpoint is proven replayable before it is trusted", () => {
  const replayable = {
    codecVersion: 1,
    nodes: [
      { exportId: "e", labels: ["Episodic"], properties: { uuid: "e", name: "items:x", group_id: "g", created_at: { $neo4j: "DateTime", fields: { year: 2026, month: 9, day: 1, hour: 0, minute: 0, second: 0, nanosecond: 0, timeZoneOffsetSeconds: 0 } } } },
      { exportId: "a", labels: ["Entity"], properties: { uuid: "a", group_id: "g", big: { $neo4j: "Integer", value: "9007199254740993" } } },
    ],
    relationships: [{ start: "e", end: "a", type: "MENTIONS", properties: {} }],
  };

  it("accepts a capture whose every property decodes through the codec the restore will use", () => {
    // "It dumped without error" is not proof. This checkpoint is the only thing between a failed
    // first import and an unrecoverable staging, so it is exercised while the original data is
    // still in place and nothing has been touched.
    expect(assertReplayableGraph(replayable)).toEqual({ nodes: 2, relationships: 1 });
  });

  it.each([
    ["an unsupported codec version", { ...replayable, codecVersion: 99 }, /unsupported graph codec version 99/],
    ["a dangling relationship endpoint", { ...replayable, relationships: [{ start: "e", end: "missing", type: "MENTIONS", properties: {} }] }, /dangling endpoint/],
    ["an unsupported label", { ...replayable, nodes: [{ exportId: "z", labels: ["Mystery"], properties: {} }], relationships: [] }, /unsupported graph node label/],
    ["a property tag the codec cannot decode", { ...replayable, nodes: [{ exportId: "z", labels: ["Entity"], properties: { odd: { $neo4j: "Quaternion", fields: {} } } }], relationships: [] }, /unsupported Neo4j codec tag/],
  ])("refuses %s rather than sealing an unrestorable checkpoint", (_label, graph, message) => {
    expect(() => assertReplayableGraph(graph)).toThrow(message as RegExp);
  });
});

describe("M6 — installed-pair verification checks the restored ledger UUID", () => {
  it("refuses a restored graph with correct names/groups but a substituted ledger UUID", async () => {
    const installed = {
      codecVersion: 1,
      nodes: [{ exportId: "ep", labels: ["Episodic"], properties: { uuid: "actual-uuid", name: "items:item-1", group_id: "team" } }],
      relationships: [],
    };
    const records = installed.nodes.map((node) => ({
      get: (key: string) => node[key as keyof typeof node],
    }));
    const session = { run: vi.fn()
      .mockResolvedValueOnce({ records })
      .mockResolvedValueOnce({ records: [] }) };
    const client = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        if (text.includes("forbidden_count")) return { rows: [{ forbidden_count: 0 }] };
        if (text.includes("FROM graph_episodes ge")) return { rows: [{
          source_table: "items", source_id: "item-1", group_id: "team", pending_delete_group_id: null,
          content_sha256: "c".repeat(64), episode_uuid: "substituted-uuid", chunk_shas: [], deferred: false, source_eligible: true,
        }] };
        if (text.includes("FROM arc_corrections a")) return { rows: [] };
        return { rows: [{ kind: "column", ident: "items.id", def: "uuid" }] };
      }),
    };
    const schemaLines = await fingerprint(client);
    const opened = { kind: "source", manifest: { runId: "run-1", mode: "copy-ready", build: { schemaFingerprint: schemaFingerprintDigest(schemaLines) } } };
    await expect(verifyInstalledPair({ client, session, graph: installed, opened, deadlines: {
      operationMs: 5_000, captureMs: 5_000, recoveryMs: 5_000, cleanupMs: 5_000, connectionMs: 5_000, terminateGraceMs: 100,
    } })).rejects.toThrow(/does not satisfy current projection ledger/);
  });
});

describe("AC-06 — full authenticated legacy rollback verifies the captured stores without copy-ready semantics", () => {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const deadlines = {
    operationMs: 5_000, captureMs: 5_000, recoveryMs: 5_000, cleanupMs: 5_000, connectionMs: 5_000, terminateGraceMs: 100,
  };
  const captured = {
    codecVersion: 1,
    nodes: [
      { exportId: "episode", labels: ["Episodic"], properties: { uuid: "legacy-episode", name: "items:legacy", group_id: "legacy_team" } },
      { exportId: "one", labels: ["Entity"], properties: { uuid: "one", group_id: "legacy_team" } },
      { exportId: "two", labels: ["Entity"], properties: { uuid: "two", group_id: "legacy_team" } },
    ],
    relationships: [
      { start: "episode", end: "one", type: "MENTIONS", properties: {} },
      { start: "one", end: "two", type: "RELATES_TO", properties: { group_id: "legacy_team", episodes: ["legacy-episode"] } },
    ],
  };
  const schemaLine = "column\titems.id\tuuid";
  const schemaDigest = schemaFingerprintDigest([schemaLine]);

  const graphSession = (graph = captured) => ({
    run: vi.fn(async (query: string) => {
      const rows = query.startsWith("MATCH (n)") ? graph.nodes : graph.relationships;
      return { records: rows.map((row) => ({ get: (key: string) => row[key as keyof typeof row] })) };
    }),
  });
  const postgres = (ledgerRows = 2) => ({
    query: vi.fn(async (sql: string) => {
      const text = String(sql);
      if (text.includes("count(*)::int AS rows FROM graph_episodes")) return { rows: [{ rows: ledgerRows }] };
      if (text.includes("from pg_attribute")) return { rows: [{ kind: "column", ident: "items.id", def: "uuid" }] };
      return { rows: [] };
    }),
  });
  const opened = ({ authenticated, kind = "staging-rollback", databaseMode = "full" }: { authenticated: boolean; kind?: string; databaseMode?: string }) => {
    const bundle = createSignedEncryptedBundle({
      payload: Buffer.from("captured-pair"),
      manifest: { kind, databaseMode, mode: "legacy-pg-only", runId: "bootstrap-legacy", build: { schemaFingerprint: schemaDigest } },
      exporterSigningPrivateKey: signing.privateKey,
      importerEncryptionPublicKey: encryption.publicKey,
    });
    const result = openSignedEncryptedBundle({
      bundle,
      exporterSigningPublicKey: signing.publicKey,
      importerEncryptionPrivateKey: encryption.privateKey,
      signerPurpose: authenticated ? "rollback" : "source",
    });
    return { ...result, kind: authenticated ? "rollback" : "source", sourceProvenance: rollbackOpeningProvenance(result) };
  };

  it("accepts a captured 3-node/2-relationship graph and non-empty ledger only for the authenticated full rollback", async () => {
    const client = postgres(2);
    const session = graphSession();
    await expect(verifyInstalledPair({
      client, session, graph: captured, opened: opened({ authenticated: true }), sanitationExpected: false, deadlines,
    })).resolves.toBeUndefined();
    expect(session.run, "the installed graph census was skipped").toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("count(*)::int AS rows FROM graph_episodes")), "the restored ledger census was skipped").toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("from pg_attribute")), "the installed schema was not measured").toBe(true);
  });

  it.each([
    ["graph census", { graph: { ...captured, relationships: captured.relationships.slice(0, 1) }, schemaFingerprint: schemaDigest }, /installed graph census differs/],
    ["schema fingerprint", { graph: captured, schemaFingerprint: "f".repeat(64) }, /catalog digest .* differs/],
  ])("still refuses a %s mismatch", async (_label, mismatch, message) => {
    const checkpoint = opened({ authenticated: true });
    checkpoint.manifest.build.schemaFingerprint = mismatch.schemaFingerprint;
    await expect(verifyInstalledPair({
      client: postgres(2), session: graphSession(), graph: mismatch.graph, opened: checkpoint, sanitationExpected: false, deadlines,
    })).rejects.toThrow(message as RegExp);
  });

  it.each([
    ["non-full rollback", opened({ authenticated: true, databaseMode: "sanitized" })],
    ["source-signed forged full rollback", opened({ authenticated: false })],
  ])("keeps legacy empty-graph semantics strict for a %s", async (_label, candidate) => {
    await expect(verifyInstalledPair({
      client: postgres(2), session: graphSession(), graph: captured, opened: candidate, sanitationExpected: false, deadlines,
    })).rejects.toThrow(/legacy mode has empty-graph semantics/);
  });
});
