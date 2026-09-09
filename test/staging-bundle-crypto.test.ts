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
});
