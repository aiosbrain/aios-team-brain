import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  preservesCapturedStagingCredentials,
  sealReadyRollback,
  verifyAndPinSourceBundle,
} from "../scripts/staging-ops/importer.mjs";
import {
  createSignedEncryptedBundle,
  openSignedEncryptedBundle,
  rollbackOpeningProvenance,
} from "../scripts/staging-ops/bundle-crypto.mjs";
import { credentialFingerprint, REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES } from "../scripts/staging-ops/credential-fingerprint.mjs";

/**
 * M3 — A SOURCE BUNDLE MUST NOT BECOME A TRUSTED FULL ROLLBACK BY BEING RE-SEALED.
 *
 * `preservesCapturedStagingCredentials` is the one predicate that decides whether an installed pair
 * restores the whole database as captured and SKIPS the tester reapply. Two of its three terms are
 * signed manifest claims; the third — importer-owned rollback provenance — is what a source manifest
 * cannot spell. The direct install path was already safe for that reason.
 *
 * The seal was not. `sealReadyRollback` mints an envelope the importer's OWN rollback key vouches
 * for, and it used to copy `databaseMode` straight out of the source manifest — so a source bundle
 * declaring `full` came back with all three terms satisfied. Its archive is sanitized, so the full
 * restore it then selects has no auth/ledger rows to restore, and the credential reapply and
 * sanitation verification that would have caught that are both skipped.
 *
 * Two properties, and the second is why the fix is not "always write sanitized": the catch-up path
 * re-seals the importer's OWN bootstrap checkpoint, and downgrading THAT would strip a legitimate
 * full staging baseline of its captured credentials.
 */

const ed25519 = () => generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const rsa = () => generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const rollbackSigning = ed25519();
const rollbackEncryption = rsa();
const sourceSigning = ed25519();
const sourceEncryption = rsa();

const ENV = {
  ROLLBACK_SIGNING_PRIVATE_KEY: rollbackSigning.privateKey,
  ROLLBACK_SIGNING_PUBLIC_KEY: rollbackSigning.publicKey,
  ROLLBACK_ENCRYPTION_PUBLIC_KEY: rollbackEncryption.publicKey,
  ROLLBACK_ENCRYPTION_PRIVATE_KEY: rollbackEncryption.privateKey,
  EXPORTER_SIGNING_PUBLIC_KEY: sourceSigning.publicKey,
  IMPORTER_ENCRYPTION_PRIVATE_KEY: sourceEncryption.privateKey,
} as unknown as NodeJS.ProcessEnv;

const COMPARISON_KEY = Buffer.alloc(32, 7);
const HEAD = "e".repeat(40);

const baseManifest = (over: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  graphCodecVersion: 1,
  runId: "run-1",
  captureStartedAt: "2026-01-01T00:00:00.000Z",
  captureEndedAt: "2026-01-01T00:01:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  checksums: Object.fromEntries(
    ["postgres", "authUsers", "graphLedger", "graph"].map((n) => [n, { sha256: "a".repeat(64), bytes: 1 }])
  ),
  build: { applicationCommit: "b".repeat(40), schemaFingerprint: "c".repeat(64), migrationSet: { sha256: "d".repeat(64) } },
  credentialFingerprints: Object.fromEntries(
    REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES.map((credentialClass: string) => [
      credentialClass,
      credentialFingerprint({ credentialClass, value: `production-${credentialClass}`, comparisonKey: COMPARISON_KEY, keyId: "seal-test" }),
    ])
  ),
  ...over,
});

/** An opened pair exactly as `openBundleBytes` builds one, on the signer purpose named. */
const openedPair = (manifest: Record<string, unknown>, purpose: "source" | "rollback") => {
  const keys = purpose === "rollback"
    ? { signPrivate: rollbackSigning.privateKey, signPublic: rollbackSigning.publicKey, encPublic: rollbackEncryption.publicKey, encPrivate: rollbackEncryption.privateKey }
    : { signPrivate: sourceSigning.privateKey, signPublic: sourceSigning.publicKey, encPublic: sourceEncryption.publicKey, encPrivate: sourceEncryption.privateKey };
  const bundle = createSignedEncryptedBundle({
    payload: Buffer.from("paired-payload"), manifest,
    exporterSigningPrivateKey: keys.signPrivate, importerEncryptionPublicKey: keys.encPublic,
  });
  const opened = openSignedEncryptedBundle({
    bundle, exporterSigningPublicKey: keys.signPublic, importerEncryptionPrivateKey: keys.encPrivate,
    signerPurpose: purpose,
  });
  return { bundle, opened: { ...opened, sourceProvenance: rollbackOpeningProvenance(opened) } };
};

describe("M3 — sealing decides databaseMode instead of copying a source claim", () => {
  it("seals a source pair as SANITIZED even when its signed manifest declares full", () => {
    // The sealed envelope is authenticated by the importer's own rollback key, so provenance is
    // genuinely satisfied here — `databaseMode` is the only thing standing between this pair and the
    // whole-database restore path. Were the claim copied, all three terms would hold.
    const { opened } = openedPair(baseManifest({ kind: "paired", databaseMode: "full", mode: "copy-ready" }), "source");
    expect(preservesCapturedStagingCredentials(opened), "the direct install path was never the hole").toBe(false);

    const sealed = sealReadyRollback(opened, HEAD, ENV);

    expect(sealed.manifest.kind).toBe("staging-rollback");
    expect(sealed.manifest.databaseMode, "the source's full claim survived the seal").toBe("sanitized");
    expect(preservesCapturedStagingCredentials(sealed), "a re-sealed source pair became a credential-preserving rollback").toBe(false);
    // …and it is genuinely an authenticated rollback envelope, so the assertion above is not passing
    // merely because provenance is missing. Only the mode stops it.
    expect(sealed.sourceProvenance, "the sealed pair is not importer-authenticated at all").not.toBeNull();
    expect(sealed.manifest.targetCommit).toBe(HEAD);
  });

  it("seals a source pair that declares nothing as sanitized, unchanged from before", () => {
    const { opened } = openedPair(baseManifest({ kind: "paired", mode: "copy-ready" }), "source");
    expect(sealReadyRollback(opened, HEAD, ENV).manifest.databaseMode).toBe("sanitized");
  });

  it("CARRIES FORWARD full mode when re-sealing the importer's own authenticated checkpoint", () => {
    // The catch-up path (`serviceCatchup`) re-seals the last-ready rollback pair against a new
    // staging head. That pair can legitimately be the bootstrap capture of staging's own database,
    // and its captured credentials are exactly what a rollback must put back — so "always write
    // sanitized" would quietly strip the full legacy baseline this fix must preserve.
    const { opened } = openedPair(
      baseManifest({ kind: "staging-rollback", databaseMode: "full", mode: "legacy-pg-only", targetCommit: "f".repeat(40) }),
      "rollback",
    );
    expect(preservesCapturedStagingCredentials(opened)).toBe(true);

    const resealed = sealReadyRollback(opened, HEAD, ENV);

    expect(resealed.manifest.databaseMode, "the bootstrap baseline was downgraded by its own catch-up").toBe("full");
    expect(preservesCapturedStagingCredentials(resealed)).toBe(true);
    expect(resealed.manifest.mode, "legacy graph semantics are part of what the checkpoint carries").toBe("legacy-pg-only");
    expect(resealed.manifest.targetCommit).toBe(HEAD);
  });

  it("does not carry a SANITIZED authenticated rollback into full either", () => {
    const { opened } = openedPair(
      baseManifest({ kind: "staging-rollback", databaseMode: "sanitized", mode: "copy-ready", targetCommit: "f".repeat(40) }),
      "rollback",
    );
    expect(sealReadyRollback(opened, HEAD, ENV).manifest.databaseMode).toBe("sanitized");
  });
});

describe("M3 — source admission refuses an explicit non-sanitized mode outright", () => {
  const pin = async (manifest: Record<string, unknown>) => {
    const { bundle } = openedPair(manifest, "source");
    const bytes = Buffer.from(JSON.stringify(bundle));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const rollbackStore = { putImmutable: vi.fn(async () => true), verify: vi.fn(async () => true) };
    const result = await verifyAndPinSourceBundle({
      objectId: `${manifest.runId}--${digest}`,
      sourceStore: { read: async () => bytes },
      rollbackStore, env: ENV,
    }).then((value: unknown) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
    return { ...result, rollbackStore };
  };

  it("refuses a full source claim before it is pinned into the staging rollback store", async () => {
    // Refused at ADMISSION, so the object never reaches importer-owned durable storage where a later
    // seal could re-open it. The message is asserted whole: a fixture that tripped two refusals at
    // once would prove only whichever fired first.
    const { error, rollbackStore } = await pin(baseManifest({ kind: "paired", databaseMode: "full", mode: "copy-ready" }));
    expect(error).toMatchObject({
      message: "source bundle refused: source bundle declares database mode full; a source capture is sanitized",
    });
    expect(rollbackStore.putImmutable, "a refused source was still copied into the rollback store").not.toHaveBeenCalled();
  });

  it("admits the exporter's own shape — the field absent, meaning sanitized", async () => {
    // The positive control for the row above: without it, a refusal that fired on every source
    // bundle would look identical.
    const { value, error } = await pin(baseManifest({ kind: "paired", mode: "copy-ready" }));
    expect(error).toBeNull();
    expect(value).toMatchObject({ kind: "source", manifest: { runId: "run-1" } });
  });
});
