import { generateKeyPairSync, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSignedEncryptedBundle } from "../scripts/staging-ops/bundle-crypto.mjs";
import { discoverLatestSource } from "../scripts/staging-ops/importer.mjs";

const sign = generateKeyPairSync("ed25519");
const enc = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = { EXPORTER_SIGNING_PUBLIC_KEY: sign.publicKey, IMPORTER_ENCRYPTION_PRIVATE_KEY: enc.privateKey } as unknown as NodeJS.ProcessEnv;

const checksums = Object.fromEntries(["postgres", "authUsers", "graphLedger", "graph"].map((n) => [n, { sha256: "a".repeat(64) }]));

function bundleFor(runId: string, capturedAt: string, { expiresAt = "2999-01-01T00:00:00.000Z" } = {}) {
  const manifest = {
    formatVersion: 1, graphCodecVersion: 1, runId,
    captureStartedAt: capturedAt, captureEndedAt: capturedAt, expiresAt, checksums,
    build: { applicationCommit: "b".repeat(40), schemaFingerprint: "c".repeat(64), migrationSet: { sha256: "d".repeat(64) } },
  };
  const bytes = Buffer.from(JSON.stringify(createSignedEncryptedBundle({
    payload: Buffer.from(runId), manifest,
    exporterSigningPrivateKey: sign.privateKey, importerEncryptionPublicKey: enc.publicKey,
  })));
  return { objectId: `${runId}--${createHash("sha256").update(bytes).digest("hex")}`, bytes };
}

/** A source store that only ever does what the real one does here: list and read. */
function storeOf(...entries: { objectId: string; bytes: Buffer }[]) {
  const byId = new Map(entries.map((entry) => [entry.objectId, entry.bytes]));
  return {
    list: async () => [...byId.keys()],
    read: async (id: string) => {
      const bytes = byId.get(id);
      if (!bytes) throw new Error(`no such object ${id}`);
      return bytes;
    },
  };
}

const RUN_1 = bundleFor("run-1", "2026-09-01T00:00:00.000Z");
const RUN_2 = bundleFor("run-2", "2026-09-08T00:00:00.000Z");
const RUN_3 = bundleFor("run-3", "2026-09-15T00:00:00.000Z");

describe("B3 — source discovery never moves staging backwards", () => {
  it("picks the newest capture when nothing is installed yet", async () => {
    const chosen = await discoverLatestSource(storeOf(RUN_1, RUN_2, RUN_3), {}, env);
    expect(chosen).toBe(RUN_3.objectId);
  });

  it("treats newest-already-installed as IDLE instead of installing the second newest", async () => {
    // The oscillation, exactly: with the newest run installed, the old rule ("newest run that is
    // not the pointer's run") selected run-2 — an OLDER bundle — and the following tick selected
    // run-3 again, forever.
    const journal = { source_watermark: "2026-09-15T00:00:00.000Z", source_watermark_run_id: "run-3" };
    expect(await discoverLatestSource(storeOf(RUN_1, RUN_2, RUN_3), journal, env)).toBeNull();
  });

  it("offers only captures strictly newer than the watermark", async () => {
    const journal = { source_watermark: "2026-09-08T00:00:00.000Z", source_watermark_run_id: "run-2" };
    expect(await discoverLatestSource(storeOf(RUN_1, RUN_2, RUN_3), journal, env)).toBe(RUN_3.objectId);
  });

  it("treats a capture at exactly the watermark as not newer", async () => {
    const journal = { source_watermark: "2026-09-15T00:00:00.000Z", source_watermark_run_id: "someone-else" };
    expect(await discoverLatestSource(storeOf(RUN_3), journal, env)).toBeNull();
  });

  it("refuses an ambiguous tie for newest rather than picking one arbitrarily", async () => {
    const twin = bundleFor("run-3b", "2026-09-15T00:00:00.000Z");
    await expect(discoverLatestSource(storeOf(RUN_3, twin), {}, env)).rejects.toThrow(/share capture end/);
  });

  it("skips an expired or unreadable object without downgrading to an older run", async () => {
    const expired = bundleFor("run-4", "2026-09-22T00:00:00.000Z", { expiresAt: "2026-09-23T00:00:00.000Z" });
    const corrupt = { objectId: "run-5--" + "f".repeat(64), bytes: Buffer.from("not a bundle") };
    const journal = { source_watermark: "2026-09-08T00:00:00.000Z", source_watermark_run_id: "run-2" };
    expect(await discoverLatestSource(storeOf(RUN_2, RUN_3, expired, corrupt), journal, env)).toBe(RUN_3.objectId);
  });

  it("skips an object whose bytes do not match its canonical digest", async () => {
    const tampered = { objectId: RUN_3.objectId, bytes: Buffer.concat([RUN_3.bytes, Buffer.from(" ")]) };
    expect(await discoverLatestSource(storeOf(RUN_2, tampered), {}, env)).toBe(RUN_2.objectId);
  });
});
