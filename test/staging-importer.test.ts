import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedEncryptedBundle } from "../scripts/staging-ops/bundle-crypto.mjs";
import { verifyAndPinSourceBundle, waitForImportedBoot } from "../scripts/staging-ops/importer.mjs";
import { PrivateFileStore } from "../scripts/staging-ops/private-store.mjs";

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
    const manifest = { formatVersion: 1, graphCodecVersion: 1, runId: "run-1", captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), checksums: Object.fromEntries(["postgres", "authUsers", "graphLedger", "graph"].map((n) => [n, { sha256: "a".repeat(64) }])), build: { applicationCommit: "b".repeat(40), schemaFingerprint: "c".repeat(64), migrationSet: { sha256: "d".repeat(64) } } };
    const bundle = createSignedEncryptedBundle({ payload: Buffer.from("payload"), manifest, exporterSigningPrivateKey: sign.privateKey, importerEncryptionPublicKey: enc.publicKey });
    const bytes = Buffer.from(JSON.stringify(bundle));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const objectId = `run-1--${digest}`;
    const source = new PrivateFileStore({ root: sourceRoot, role: "publisher" }); await source.putImmutable(objectId, bytes);
    const opened = await verifyAndPinSourceBundle({ objectId, sourceStore: new PrivateFileStore({ root: sourceRoot, role: "source-reader" }), rollbackStore: new PrivateFileStore({ root: rollbackRoot, role: "rollback-owner" }), env: { EXPORTER_SIGNING_PUBLIC_KEY: sign.publicKey, IMPORTER_ENCRYPTION_PRIVATE_KEY: enc.privateKey } });
    expect(opened.manifest.runId).toBe("run-1");
    expect((await new PrivateFileStore({ root: rollbackRoot, role: "rollback-owner" }).read(objectId)).length).toBeGreaterThan(0);
  });
});
