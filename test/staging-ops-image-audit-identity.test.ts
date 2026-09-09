import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  AuditIdentityError,
  classifyLayerMember,
  gunzipToSha,
  mergedFilesystem,
  revisionLabelFailures,
  sha256,
  verifyConfig,
  verifyManifest,
  whiteoutOf,
} from "../scripts/staging-ops/image-audit/layers.mjs";
import { SUBJECT, SUBJECT_REFERENCE, assertSubjectShape } from "../scripts/staging-ops/image-audit/subject.mjs";

/**
 * PUB-02's identity rows.
 *
 * WHAT THESE FIXTURES ARE. Correctly hashed synthetic manifests/configs: small JSON documents whose
 * sha256 is computed over their own bytes, which is exactly the property the chain checks. They are
 * not BuildKit output, and a green run here does NOT say the real pinned digest passed anything —
 * that is the live audit's job, on the runner, against the registry.
 */

const layerBody = (text: string) => Buffer.from(text, "utf8");

function imageFixture(options: {
  layers?: { body: Buffer; mediaType?: string }[];
  labels?: Record<string, string>;
  os?: string;
  architecture?: string;
  configMediaType?: string;
  manifestMediaType?: string;
  diffIdsOverride?: string[];
} = {}) {
  const layers = options.layers ?? [{ body: layerBody("layer-one") }, { body: layerBody("layer-two") }];
  const blobs = layers.map((layer) => gzipSync(layer.body));
  const config = {
    architecture: options.architecture ?? "amd64",
    os: options.os ?? "linux",
    config: {
      Env: ["PATH=/usr/local/bin"],
      Entrypoint: ["/usr/bin/tini", "-s", "--", "node"],
      User: "node",
      Labels: options.labels ?? {
        "org.opencontainers.image.revision": SUBJECT.sourceRevision,
        "org.opencontainers.image.source": `https://github.com/${SUBJECT.repository}`,
      },
    },
    history: [{ created_by: "RUN npm ci --ignore-scripts" }],
    rootfs: { type: "layers", diff_ids: options.diffIdsOverride ?? layers.map((layer) => sha256(layer.body)) },
  };
  const configBytes = Buffer.from(JSON.stringify(config), "utf8");
  const manifest = {
    schemaVersion: 2,
    mediaType: options.manifestMediaType ?? "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: options.configMediaType ?? "application/vnd.oci.image.config.v1+json",
      digest: sha256(configBytes),
      size: configBytes.length,
    },
    layers: blobs.map((blob, index) => ({
      mediaType: layers[index].mediaType ?? "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: sha256(blob),
      size: blob.length,
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  return { manifest, manifestBytes, manifestDigest: sha256(manifestBytes), config, configBytes, blobs, layers };
}

describe("the pinned subject is one reviewed tuple (PUB-01)", () => {
  it("is well formed and derives its receipt tag from the publisher's own tag builder", () => {
    expect(() => assertSubjectShape()).not.toThrow();
    expect(SUBJECT.receiptTag).toBe(`sha-${SUBJECT.sourceRevision}-run-${SUBJECT.originalRunId}.${SUBJECT.originalRunAttempt}`);
    expect(SUBJECT_REFERENCE).toBe(`ghcr.io/aiosbrain/aios-staging-ops@${SUBJECT.digest}`);
  });

  it("pins the exact digest, source revision and original run the coordinator accepted", () => {
    // Written out rather than referenced, because "the subject is whatever the constant says" is not
    // a check. If this file is edited to audit a different artifact, this row is the red diff.
    expect(SUBJECT.digest).toBe("sha256:00058245a63cfe0da5ed69c2dc3c0225dc9c17cde82e6b5ff157caf527f88d0f");
    expect(SUBJECT.sourceRevision).toBe("11eb039bd07ed82d0b2dc052e3fc2611879bf063");
    expect(SUBJECT.originalRunId).toBe("34398108263");
    expect(SUBJECT.originalRunAttempt).toBe("1");
  });

  it("rejects a subject whose receipt tag does not follow from its own run identity", () => {
    expect(() => assertSubjectShape({ ...SUBJECT, receiptTag: "sha-deadbeef-run-1.1" })).toThrow(/receipt tag/);
    expect(() => assertSubjectShape({ ...SUBJECT, digest: "sha256:short" })).toThrow(/digest/);
  });
});

describe("manifest identity (PUB-02)", () => {
  it("accepts registry bytes that hash to the expected digest", () => {
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    expect(manifest.digest).toBe(image.manifestDigest);
    expect(manifest.layers).toHaveLength(2);
  });

  /** THE MUTANT THIS EXISTS FOR: one byte of the served manifest differing from the pinned subject. */
  it("refuses bytes that hash to anything else — exact digest mismatch", () => {
    const image = imageFixture();
    const other = imageFixture({ layers: [{ body: layerBody("different") }] });
    expect(() => verifyManifest(other.manifestBytes, image.manifestDigest)).toThrow(AuditIdentityError);
    expect(() => verifyManifest(image.manifestBytes, image.manifestDigest.replace(/.$/, "0"))).toThrow(/not the pinned subject digest/);
    expect(() => verifyManifest("", image.manifestDigest)).toThrow(/no manifest bytes/);
  });

  it("refuses an index/manifest-list rather than picking a child", () => {
    const image = imageFixture({ manifestMediaType: "application/vnd.oci.image.index.v1+json" });
    expect(() => verifyManifest(image.manifestBytes, image.manifestDigest)).toThrow(/single-platform image manifest/);
  });

  it("refuses a layer media type it cannot decode, by name, instead of guessing gzip", () => {
    const image = imageFixture({ layers: [{ body: layerBody("z"), mediaType: "application/vnd.oci.image.layer.v1.tar+zstd" }] });
    expect(() => verifyManifest(image.manifestBytes, image.manifestDigest)).toThrow(/cannot decode/);
  });

  it("refuses a manifest with no layers or no config descriptor", () => {
    const empty = Buffer.from(JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "sha256:" + "a".repeat(64) }, layers: [] }), "utf8");
    expect(() => verifyManifest(empty, sha256(empty))).toThrow(/zero layers/);
    const noConfig = Buffer.from(JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [] }), "utf8");
    expect(() => verifyManifest(noConfig, sha256(noConfig))).toThrow(/config descriptor/);
  });
});

describe("config identity, platform and provenance labels (PUB-02)", () => {
  it("hashes the exported config against the MANIFEST's descriptor", () => {
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    const config = verifyConfig(image.configBytes, manifest, { platform: "linux/amd64" });
    expect(config.diffIds).toHaveLength(2);
  });

  it("refuses a config that is not the one the manifest names", () => {
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    // One byte of real difference — a second Env entry. The config still PARSES and still looks like
    // this image's config, which is the whole point: only the hash separates them.
    const tampered = Buffer.from(
      image.configBytes.toString("utf8").replace('"PATH=/usr/local/bin"', '"PATH=/usr/local/bin","EXTRA=1"'),
      "utf8",
    );
    expect(tampered.equals(image.configBytes)).toBe(false);
    expect(() => verifyConfig(tampered, manifest)).toThrow(/not the manifest's config descriptor/);
  });

  it("refuses a config whose diff_id count disagrees with the manifest's layer count — a MISSING LAYER", () => {
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    const short = imageFixture({ diffIdsOverride: [sha256(layerBody("layer-one"))] });
    // Re-hash so the ONLY thing wrong is the count, not the digest — otherwise this would pass for
    // the wrong reason and prove nothing about layer accounting.
    const patched = { ...manifest, config: { ...manifest.config, digest: sha256(short.configBytes) } };
    expect(() => verifyConfig(short.configBytes, patched)).toThrow(/diff_ids but the manifest declares/);
  });

  it("refuses a config for another platform", () => {
    const image = imageFixture({ architecture: "arm64" });
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    expect(() => verifyConfig(image.configBytes, manifest, { platform: "linux/amd64" })).toThrow(/not the pinned linux\/amd64/);
  });

  it("requires the revision/source labels to equal the pinned image source", () => {
    const image = imageFixture();
    expect(revisionLabelFailures(image.config, SUBJECT)).toEqual([]);
    const wrong = imageFixture({ labels: { "org.opencontainers.image.revision": "0".repeat(40) } });
    expect(revisionLabelFailures(wrong.config, SUBJECT)).toHaveLength(2);
  });
});

describe("layer identity: both accepted export forms are PROVED, others fail (PUB-02)", () => {
  it("verifies a compressed registry blob by descriptor, then by diff_id", () => {
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    const config = verifyConfig(image.configBytes, manifest);
    const outcome = classifyLayerMember({
      rawSha: sha256(image.blobs[0]),
      descriptor: manifest.layers[0],
      diffId: config.diffIds[0],
      decode: gunzipToSha(image.blobs[0]),
    });
    expect(outcome).toMatchObject({ form: "compressed-blob", verified: true, decoded: true });
  });

  it("verifies an uncompressed diff member without attempting a decode", () => {
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    const config = verifyConfig(image.configBytes, manifest);
    const outcome = classifyLayerMember({
      rawSha: config.diffIds[0],
      descriptor: manifest.layers[0],
      diffId: config.diffIds[0],
      // A NEGATIVE CONTROL, not decoration: if this branch ever started decoding, the throw would
      // surface it instead of the test passing for a reason it did not check.
      decode: () => { throw new Error("a decode must not be attempted on an uncompressed diff"); },
    });
    expect(outcome).toMatchObject({ form: "uncompressed-diff", verified: true, decoded: false });
  });

  it("FAILS an export member that is neither — no third form is guessed at", () => {
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    const config = verifyConfig(image.configBytes, manifest);
    expect(() => classifyLayerMember({
      rawSha: sha256(Buffer.from("something else")),
      descriptor: manifest.layers[0],
      diffId: config.diffIds[0],
      decode: gunzipToSha(Buffer.from("something else")),
    })).toThrow(/unsupported-export-form/);
  });

  it("FAILS a blob whose descriptor matches but whose decode does not reach the diff_id", () => {
    // The half-verified case: right blob identity, wrong content underneath. Checking only the
    // descriptor digest would call this layer verified while scanning bytes nothing vouches for.
    const image = imageFixture();
    const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
    expect(() => classifyLayerMember({
      rawSha: sha256(image.blobs[0]),
      descriptor: manifest.layers[0],
      diffId: sha256(Buffer.from("not this")),
      decode: gunzipToSha(image.blobs[0]),
    })).toThrow(/not its declared diff_id/);
  });

  it("FAILS a blob that does not decompress at all", () => {
    const notGzip = Buffer.from("plain bytes pretending to be a gzip layer");
    const digest = sha256(notGzip);
    expect(() => classifyLayerMember({
      rawSha: digest,
      descriptor: { digest, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" },
      diffId: sha256(Buffer.from("anything")),
      decode: gunzipToSha(notGzip),
    })).toThrow(/did not decompress/);
  });
});

describe("whiteouts: the merged filesystem is not the artifact (PUB-02, PUB-07)", () => {
  it("classifies delete and opaque whiteout members", () => {
    expect(whiteoutOf("app/.wh.secret.pem")).toEqual({ kind: "delete", target: "app/secret.pem" });
    expect(whiteoutOf("app/.wh..wh..opq")).toEqual({ kind: "opaque", target: "app/" });
    expect(whiteoutOf("app/ordinary.js")).toEqual({ kind: "none" });
  });

  it("reports a file DELETED by a later layer as invisible but still layered", () => {
    const { visible, shadowed } = mergedFilesystem([
      ["app/credentials.json", "app/index.js"],
      ["app/.wh.credentials.json"],
    ]);
    expect(visible.has("app/credentials.json")).toBe(false);
    expect(shadowed).toContainEqual({ path: "app/credentials.json", layer: 0, removedBy: 1, reason: "deleted" });
    // …and the surviving file is still accounted for, so "invisible" is a measured difference
    // between two sets rather than an empty result that would look the same if nothing were read.
    expect(visible.get("app/index.js")).toBe(0);
  });

  it("reports a file OVERWRITTEN by a later layer, whose earlier bytes remain distributed", () => {
    const { visible, shadowed } = mergedFilesystem([["app/.env"], ["app/.env"]]);
    expect(visible.get("app/.env")).toBe(1);
    expect(shadowed).toContainEqual({ path: "app/.env", layer: 0, removedBy: 1, reason: "overwritten" });
  });

  it("reports an opaque directory hiding every earlier entry beneath it", () => {
    const { visible, shadowed } = mergedFilesystem([
      ["build/key.pem", "build/notes.txt", "app/keep.js"],
      ["build/.wh..wh..opq"],
    ]);
    expect([...visible.keys()]).toEqual(["app/keep.js"]);
    expect(shadowed.map((entry) => entry.path).sort()).toEqual(["build/key.pem", "build/notes.txt"]);
    expect(shadowed.every((entry) => entry.reason === "opaque-directory")).toBe(true);
  });
});
