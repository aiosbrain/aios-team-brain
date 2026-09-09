/**
 * AIO-997 audit — THE IDENTITY CHAIN, and what each layer actually contains.
 *
 * THE CHAIN, in the order it must hold (PUB-02):
 *
 *   registry bytes ──sha256──▶ the PINNED manifest digest
 *   manifest.config ──sha256──▶ the config bytes read from the export
 *   manifest.layers[i] ──sha256──▶ the compressed blob   ──decode(mediaType)──▶ config.rootfs.diff_ids[i]
 *
 * Nothing in here accepts "already verified" from a caller. Each step recomputes a hash from bytes,
 * which is why a LOCAL image id — the thing `docker images` shows and the thing it is easiest to
 * mistake for an artifact identity — cannot enter at any point: it hashes to nothing in this chain.
 *
 * THE EXPORT FORM (PUB-02, deliberately narrow). A `docker save` archive may present a layer as the
 * original COMPRESSED registry blob or as the UNCOMPRESSED diff. This module does not guess which,
 * and does not carry a compatibility framework for stores it has not measured: it hashes the member
 * and accepts it only if that hash IS the layer descriptor digest or IS the diff_id. Both accepted
 * branches are proved by hash; anything else is `unsupported-export-form`, which FAILS the audit.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { CONFIG_MEDIA_TYPES, LAYER_MEDIA_TYPES, isDigest } from "./subject.mjs";
import { ACCEPTED_MEDIA_TYPES } from "../image-publication.mjs";

export class AuditIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditIdentityError";
  }
}

const fail = (message) => {
  throw new AuditIdentityError(message);
};

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The registry's answer for the pinned by-digest reference, recomputed from its own bytes.
 *
 * Same property the publisher's `confirmRegistryManifest` proves, asserted here against the PINNED
 * subject rather than against a digest a build step just emitted — the audit is not publishing
 * anything, so the only digest it may trust is the one in reviewed source.
 */
export function verifyManifest(rawManifest, expectedDigest) {
  const bytes = Buffer.isBuffer(rawManifest) ? rawManifest : Buffer.from(String(rawManifest ?? ""), "utf8");
  if (bytes.length === 0) fail("registry returned no manifest bytes for the pinned subject");
  const measured = sha256(bytes);
  if (measured !== expectedDigest) fail(`registry manifest hashes to ${measured}, not the pinned subject digest ${expectedDigest}`);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("the registry manifest is not parseable JSON");
  }
  if (!ACCEPTED_MEDIA_TYPES.includes(manifest?.mediaType)) {
    fail(`the pinned subject is ${String(manifest?.mediaType)}; this audit inspects a single-platform image manifest (${ACCEPTED_MEDIA_TYPES.join(" or ")})`);
  }
  const config = manifest?.config;
  if (!isDigest(config?.digest)) fail("the manifest declares no sha256 config descriptor");
  if (!CONFIG_MEDIA_TYPES.includes(config?.mediaType)) fail(`the manifest config descriptor is ${String(config?.mediaType)}, which this audit does not recognise`);
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : fail("the manifest declares no layer array");
  if (layers.length === 0) fail("the manifest declares zero layers");
  layers.forEach((layer, index) => {
    if (!isDigest(layer?.digest)) fail(`manifest layer ${index} has no sha256 digest`);
    if (!LAYER_MEDIA_TYPES[layer?.mediaType]) {
      // Refused BY NAME. A layer this module cannot decode is missing coverage, and missing coverage
      // must fail rather than be reported as a clean scan of the layers that happened to decode.
      fail(`manifest layer ${index} is ${String(layer?.mediaType)}, which this audit cannot decode (supported: ${Object.keys(LAYER_MEDIA_TYPES).join(", ")})`);
    }
  });
  return Object.freeze({ digest: measured, mediaType: manifest.mediaType, config, layers: Object.freeze(layers) });
}

/** The config bytes read from the export, hashed against the MANIFEST's config descriptor. */
export function verifyConfig(configBytes, manifest, { platform } = {}) {
  const bytes = Buffer.isBuffer(configBytes) ? configBytes : Buffer.from(String(configBytes ?? ""), "utf8");
  const measured = sha256(bytes);
  if (measured !== manifest.config.digest) {
    fail(`the exported image config hashes to ${measured}, not the manifest's config descriptor ${manifest.config.digest}`);
  }
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("the exported image config is not parseable JSON");
  }
  const diffIds = config?.rootfs?.diff_ids;
  if (!Array.isArray(diffIds) || diffIds.length === 0) fail("the image config declares no rootfs.diff_ids");
  if (diffIds.length !== manifest.layers.length) {
    fail(`the image config declares ${diffIds.length} diff_ids but the manifest declares ${manifest.layers.length} layers`);
  }
  diffIds.forEach((id, index) => { if (!isDigest(id)) fail(`rootfs.diff_ids[${index}] is not a sha256 digest`); });
  if (platform) {
    const [os, architecture] = String(platform).split("/");
    if (config?.os !== os || config?.architecture !== architecture) {
      fail(`the image config is ${String(config?.os)}/${String(config?.architecture)}, not the pinned ${platform}`);
    }
  }
  return Object.freeze({ digest: measured, config, diffIds: Object.freeze([...diffIds]) });
}

/**
 * PUB-02's provenance labels. A label is a CLAIM the builder wrote, so this is one input among the
 * receipt tag readback and the original run — "a source label alone is insufficient provenance" is
 * the spec's line, and the audit records all three rather than letting this one stand in for them.
 */
export function revisionLabelFailures(config, subject) {
  const labels = config?.config?.Labels ?? config?.Labels ?? {};
  const failures = [];
  const revision = labels["org.opencontainers.image.revision"];
  const source = labels["org.opencontainers.image.source"];
  if (revision !== subject.sourceRevision) failures.push(`image revision label is ${JSON.stringify(String(revision ?? ""))}, expected the pinned source ${subject.sourceRevision}`);
  if (source !== `https://github.com/${subject.repository}`) failures.push(`image source label is ${JSON.stringify(String(source ?? ""))}, expected https://github.com/${subject.repository}`);
  return failures;
}

/**
 * Prove which end of the chain ONE exported layer member sits at.
 *
 * `rawSha` is the sha256 of the member's bytes as they sit in the export. `decode()` is called ONLY
 * on the compressed-blob branch and returns the sha256 of the decompressed bytes — the caller decides
 * whether that decode happened in memory (tests) or streamed to scratch (the job), so there is one
 * decision point here rather than two implementations that could drift apart.
 *
 * The return says which form was MEASURED, never assumed, so the evidence record can state it.
 */
export function classifyLayerMember({ rawSha, descriptor, diffId, decode }) {
  if (rawSha === diffId) {
    // Already the uncompressed diff: its hash IS the diff_id, so no decode is needed or attempted.
    return { form: "uncompressed-diff", diffId, verified: true, decoded: false };
  }
  if (rawSha !== descriptor.digest) {
    fail(
      `an exported layer member hashes to ${rawSha}, which is neither its manifest descriptor ` +
      `${descriptor.digest} nor its diff_id ${diffId}; this audit supports only export forms whose ` +
      `layer identity it can prove (unsupported-export-form)`
    );
  }
  const codec = LAYER_MEDIA_TYPES[descriptor.mediaType];
  // Decoded ACCORDING TO THE DECLARED MEDIA TYPE, never by guessing gzip: a `+zstd` layer never
  // reaches here because `verifyManifest` already refused it by name.
  if (codec !== "gzip") fail(`layer ${descriptor.digest} declares ${descriptor.mediaType}; only its descriptor digest was verified, not a decode`);
  let measured;
  try {
    measured = decode();
  } catch (error) {
    fail(`layer ${descriptor.digest} declares ${descriptor.mediaType} but did not decompress: ${error?.message ?? "decode failed"}`);
  }
  if (measured !== diffId) fail(`layer ${descriptor.digest} decompresses to ${measured}, not its declared diff_id ${diffId}`);
  return { form: "compressed-blob", diffId, verified: true, decoded: true };
}

/** The in-memory decode, for a caller that already holds the blob (fixtures, small blobs). */
export function gunzipToSha(bytes) {
  return () => sha256(gunzipSync(bytes));
}

// ---------------------------------------------------------------------------
// Whiteouts — why "inspect the merged filesystem" is not an audit
// ---------------------------------------------------------------------------

const OPAQUE = ".wh..wh..opq";
const WHITEOUT = ".wh.";

/** What a member name means in overlay terms. A whiteout DELETES; it is not a file called `.wh.x`. */
export function whiteoutOf(name) {
  const at = name.lastIndexOf("/");
  const dir = at === -1 ? "" : name.slice(0, at + 1);
  const base = at === -1 ? name : name.slice(at + 1);
  if (base === OPAQUE) return { kind: "opaque", target: dir };
  if (base.startsWith(WHITEOUT)) return { kind: "delete", target: `${dir}${base.slice(WHITEOUT.length)}` };
  return { kind: "none" };
}

/**
 * Which paths survive into the MERGED filesystem, and which were deleted or overwritten on the way.
 *
 * This exists to make the audit's central claim measurable: a secret written in layer 1 and deleted
 * in layer 4 is INVISIBLE in the merged filesystem and still fully distributed in the layer blob.
 * Every layer's content is inspected regardless of this; the merged view is only used to REPORT that
 * a finding is invisible to anyone who inspects a started container.
 */
export function mergedFilesystem(layerPaths) {
  const visible = new Map();
  const shadowed = [];
  layerPaths.forEach((paths, index) => {
    for (const name of paths) {
      const white = whiteoutOf(name);
      if (white.kind === "delete") {
        if (visible.has(white.target)) shadowed.push({ path: white.target, layer: visible.get(white.target), removedBy: index, reason: "deleted" });
        visible.delete(white.target);
        continue;
      }
      if (white.kind === "opaque") {
        for (const existing of [...visible.keys()]) {
          if (existing.startsWith(white.target) && existing !== white.target) {
            shadowed.push({ path: existing, layer: visible.get(existing), removedBy: index, reason: "opaque-directory" });
            visible.delete(existing);
          }
        }
        continue;
      }
      if (visible.has(name)) shadowed.push({ path: name, layer: visible.get(name), removedBy: index, reason: "overwritten" });
      visible.set(name, index);
    }
  });
  return { visible, shadowed };
}
