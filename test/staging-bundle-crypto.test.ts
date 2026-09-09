/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createSignedEncryptedBundle, openSignedEncryptedBundle } from "../scripts/staging-ops/bundle-crypto.mjs";

const signing = generateKeyPairSync("ed25519");
const importer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = (value: any, kind: "public" | "private") => value.export({ type: kind === "public" ? "spki" : "pkcs8", format: "pem" });

describe("signed encrypted staging bundle", () => {
  it("signs publisher identity and seals an AES-256-GCM run key to the importer", () => {
    const payload = Buffer.from(JSON.stringify({ pg: "archive", graph: [1, 2, 3] }));
    const bundle = createSignedEncryptedBundle({
      payload,
      manifest: { runId: "run-1", formatVersion: 1, captureStartedAt: "2026-09-07T00:00:00Z", captureEndedAt: "2026-09-07T00:01:00Z" },
      exporterSigningPrivateKey: key(signing.privateKey, "private"),
      importerEncryptionPublicKey: key(importer.publicKey, "public"),
    });
    const opened = openSignedEncryptedBundle({
      bundle,
      exporterSigningPublicKey: key(signing.publicKey, "public"),
      importerEncryptionPrivateKey: key(importer.privateKey, "private"),
    });
    expect(opened.payload).toEqual(payload);
    expect(opened.manifest.runId).toBe("run-1");
    expect(bundle.manifest.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it.each(["ciphertext", "manifest", "signature"] as const)("refuses tampered %s before returning plaintext", (part) => {
    const bundle = createSignedEncryptedBundle({
      payload: Buffer.from("private data"),
      manifest: { runId: "run-2", formatVersion: 1 },
      exporterSigningPrivateKey: key(signing.privateKey, "private"),
      importerEncryptionPublicKey: key(importer.publicKey, "public"),
    });
    const changed = structuredClone(bundle);
    if (part === "ciphertext") changed.ciphertext = `${changed.ciphertext.slice(0, -2)}AA`;
    if (part === "manifest") changed.manifest.runId = "other";
    if (part === "signature") changed.manifest.signature = `${changed.manifest.signature.slice(0, -2)}AA`;
    expect(() => openSignedEncryptedBundle({
      bundle: changed,
      exporterSigningPublicKey: key(signing.publicKey, "public"),
      importerEncryptionPrivateKey: key(importer.privateKey, "private"),
    })).toThrow(/signature|digest|authenticate|decrypt/i);
  });

  describe("AES-GCM authentication tag length", () => {
    const payload = Buffer.from("private data that must not leak on a weakened tag");
    const sealed = () => createSignedEncryptedBundle({
      payload,
      manifest: { runId: "run-3", formatVersion: 1 },
      exporterSigningPrivateKey: key(signing.privateKey, "private"),
      importerEncryptionPublicKey: key(importer.publicKey, "public"),
    });
    const open = (bundle: any) => openSignedEncryptedBundle({
      bundle,
      exporterSigningPublicKey: key(signing.publicKey, "public"),
      importerEncryptionPrivateKey: key(importer.privateKey, "private"),
    });

    // Positive control for the three rejection cases below. Without it a truncated-tag test could
    // go green because the fixture is broken in some OTHER way, and would still be green if the
    // module refused every bundle it is ever handed.
    it("emits a full 16-byte tag and opens the untouched bundle", () => {
      const bundle = sealed();
      expect(Buffer.from(bundle.authTag, "base64")).toHaveLength(16);
      expect(open(bundle).payload).toEqual(payload);
    });

    // Node's GCM decipher accepts 4/8/12–16-byte tags unless a length is pinned, and verifies only
    // the bytes it is given. Each truncation below is therefore a VALID prefix of the real tag —
    // the only defect in the fixture is its length, which is what `authTagLength: 16` now refuses.
    it.each([4, 8, 12])("refuses a valid tag truncated to %i bytes", (bytes) => {
      const bundle = sealed();
      const full = Buffer.from(bundle.authTag, "base64");
      const truncated = { ...bundle, authTag: full.subarray(0, bytes).toString("base64") };
      expect(full.subarray(0, bytes)).toEqual(Buffer.from(truncated.authTag, "base64"));
      expect(() => open(truncated)).toThrow(/authenticated decryption failed/i);
    });

    // Length alone is not the property under test: a full-length tag that is not THE tag must fail
    // too, or the fix above would be satisfied by a module that only counted bytes.
    it("refuses a full-length tag whose bytes were altered", () => {
      const bundle = sealed();
      const forged = Buffer.from(bundle.authTag, "base64");
      forged[0] ^= 0xff;
      expect(forged).toHaveLength(16);
      expect(() => open({ ...bundle, authTag: forged.toString("base64") })).toThrow(/authenticated decryption failed/i);
    });
  });
});
