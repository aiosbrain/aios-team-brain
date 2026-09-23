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
import { assertMemberPathBounded } from "./tar-reader.mjs";
import { createRetainedStateBudget, createWorkBudget } from "./budgets.mjs";
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
 *
 * THE PRIVACY DEFECT THIS SHAPE EXISTS FOR (F10). These failures are exported by `runAudit` into the
 * PUBLIC evidence artifact, and the previous version interpolated the OBSERVED label value into each
 * message. Labels are arbitrary strings a builder chose: `OCI` labels routinely carry internal
 * hostnames, branch names, ticket references and — in the case this check is for, a build that did
 * something unexpected — whatever the builder put there. The generic secret-shape guard in
 * `evidence.mjs` is a backstop for credential-shaped values, not a filter for arbitrary private
 * prose, and relying on it to catch a value the audit chose to publish is the wrong order of defence.
 *
 * So each failure is a FIXED CODE plus the EXPECTED identity, which is already public: it is in
 * reviewed source, in the pinned subject, and in this repository's URL. Nothing observed is emitted.
 * A coordinator who needs the actual value reads it from private scratch in a bounded rerun, which is
 * the same access limitation every other unresolved occurrence carries.
 */
export function revisionLabelFailures(config, subject) {
  const labels = config?.config?.Labels ?? config?.Labels ?? {};
  const expected = {
    "org.opencontainers.image.revision": subject.sourceRevision,
    "org.opencontainers.image.source": `https://github.com/${subject.repository}`,
  };
  const failures = [];
  for (const [label, want] of Object.entries(expected)) {
    const observed = labels[label];
    if (typeof observed !== "string" || observed === "") {
      failures.push(Object.freeze({ label, code: "label-missing", expected: want }));
    } else if (observed !== want) {
      // `code` says WHICH way it failed; `expected` says what the audit required. The observed value
      // is deliberately absent — that is the whole point of this function's shape.
      failures.push(Object.freeze({ label, code: "label-mismatch", expected: want }));
    }
  }
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
  /**
   * The BASENAME after one trailing `/` is dropped (B6). Extractors test the cleaned basename whatever
   * the entry's type, so a directory-typed `app/.wh.d/` is a whiteout of `app/d` to them. Reading the
   * empty text after that slash as "no whiteout" left `app/d/x.js` visible. The inspector separately
   * records any marker that is not an EMPTY REGULAR file — the only form OCI permits — as a gap.
   */
  const clean = name.endsWith("/") ? name.slice(0, -1) : name;
  const at = clean.lastIndexOf("/");
  const dir = at === -1 ? "" : clean.slice(0, at + 1);
  const base = at === -1 ? clean : clean.slice(at + 1);
  if (base === OPAQUE) return { kind: "opaque", target: dir };
  if (base.startsWith(WHITEOUT)) {
    /**
     * An ordinary whiteout naming NOTHING, the directory itself or its parent (`.wh.`, `.wh..`,
     * `.wh...`) is malformed (L6): containerd refuses to unpack it, and applying it here would delete
     * the root or a parent. It is reported as `malformed` and deletes nothing. (The exact
     * `.wh..wh..opq` opaque marker is handled above, before this rule.)
     */
    const named = base.slice(WHITEOUT.length);
    if (named === "" || named === "." || named === "..") return { kind: "malformed" };
    return { kind: "delete", target: `${dir}${named}` };
  }
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
/**
 * Every PROPER ancestor directory key of `key` (`a/`, `a/b/` for `a/b/c`), found by walking the
 * separators of the original string once — no repeated split/join (B9). `visit` may stop early by
 * returning `true`. Callers bound the path first (`assertMemberPathBounded`), so this is at most
 * `MEMBER_PATH_LIMITS.maxSegments` steps.
 */
export function forEachAncestor(key, visit) {
  const end = key.endsWith("/") ? key.length - 1 : key.length;
  for (let at = key.indexOf("/"); at !== -1 && at < end; at = key.indexOf("/", at + 1)) {
    if (visit(key.slice(0, at + 1)) === true) return true;
  }
  return false;
}

/**
 * The merged view, under the run's TWO authorities (B9-R): `retained` bounds the logical bytes of state
 * this function keeps (visible, shadowed, the ancestor index, layer-local sets and the B10 ordering
 * state), and `work` bounds CPU steps and consults the deadline. Direct callers get finite defaults.
 */
export function mergedFilesystem(layerPaths, {
  deadline,
  retained = createRetainedStateBudget(),
  work = createWorkBudget({ deadline }),
} = {}) {
  const visible = new Map();
  const shadowed = [];
  /**
   * Layers in which the merged view is AMBIGUOUS (B6, B8): a file and a directory of one name, a
   * non-directory with entries beneath it, entries beneath a lower non-directory, or an ORDINARY
   * whiteout that overlaps an entry of its own layer (OCI says whiteouts apply only to lower layers;
   * containerd v2.1.4 removes the entry when the whiteout follows it). Extractors do not agree on these,
   * so the inspector records each as a blocking gap rather than picking one outcome.
   */
  const conflicts = new Set();

  const ancestors = (key, visit) => forEachAncestor(key, (ancestor) => { work.step("merged namespace"); return visit(ancestor); });

  /**
   * THE KEY MODEL. A directory key ends in `/` (canonical directory identity is type-driven, so `app`
   * and `app/` written as directories are one key); every other key does not. `.` is the root.
   *
   * SEGMENT INDEX. `beneath` maps a directory key to the visible keys strictly under it, so a subtree
   * removal is a lookup rather than a scan of every visible key.
   */
  const beneath = new Map();
  const place = (key, layer) => {
    assertMemberPathBounded(key);
    work.step("merged namespace placement");
    // The visible entry itself: its key string and the map membership, charged before the insertion.
    if (!visible.has(key)) retained.path(key);
    visible.set(key, layer);
    ancestors(key, (ancestor) => {
      let set = beneath.get(ancestor);
      if (!set) {
        // A new ancestor container is charged (and stays charged) even if every member later leaves.
        retained.container(ancestor);
        beneath.set(ancestor, (set = new Set()));
      }
      // A relation is only free when the exact membership is PROVEN to exist already.
      retained.relation(ancestor, { alreadyMember: set.has(key) });
      set.add(key);
    });
  };
  const remove = (key, removedBy, reason) => {
    work.step("merged namespace removal");
    if (!visible.has(key)) return;
    // The shadow record is retained for the whole run: charge it before pushing.
    retained.record(2);
    retained.string(key);
    retained.string(reason);
    shadowed.push({ path: key, layer: visible.get(key), removedBy, reason });
    visible.delete(key);
    ancestors(key, (ancestor) => { beneath.get(ancestor)?.delete(key); });
  };
  /**
   * `target` itself, its directory spelling, and everything beneath it — on a segment boundary. The
   * snapshot array is real retained state while it exists, so each member is charged before the copy.
   */
  const subtree = (target) => {
    const out = [target, `${target}/`];
    retained.membership(2);
    for (const key of beneath.get(`${target}/`) ?? []) {
      work.step("merged namespace subtree");
      retained.membership();
      out.push(key);
    }
    return out;
  };
  const isDirectoryKey = (key) => key.endsWith("/") || key === ".";

  /**
   * Is any proper ancestor of this MARKER currently a non-directory — from a lower layer, or written
   * earlier in this same layer — with no explicit directory entry before the marker to replace it?
   * Bounded by the shared work authority, one step per ancestor, and it follows no link.
   */
  const markerParentConflict = (markerName, explicitDirsSeen, nonDirsSeenHere) => ancestors(markerName, (ancestor) => {
    if (explicitDirsSeen.has(ancestor)) return false; // replaced by an explicit directory, before the marker
    const bare = ancestor.slice(0, -1);
    if (nonDirsSeenHere.has(bare)) return true; // a file this layer wrote earlier
    return visible.has(bare) && !isDirectoryKey(bare); // a file a lower layer left there
  });

  /**
   * Does any EARLIER same-layer descendant of `target` depend on an intermediate directory that was not
   * declared before this marker? Bounded: every candidate costs a step BEFORE the prefix test, so a
   * layer full of unrelated markers cannot buy unchecked quadratic scanning, and no second transitive
   * index is built — the per-layer set of declared directories plus this scan is the whole state.
   */
  const opaqueOrderAmbiguity = (target, earlierOrdinary, explicitDirsSeen) => {
    for (const candidate of earlierOrdinary) {
      work.step("opaque ordering candidate");
      // `target` ends in `/`, or is `""` for the root marker — where every earlier entry is a candidate.
      if (candidate === target || candidate === "." || !candidate.startsWith(target)) continue;
      const missing = forEachAncestor(candidate, (ancestor) => {
        work.step("opaque ordering ancestor");
        // Only the directories strictly BETWEEN the marker's target and this descendant matter.
        if (ancestor.length <= target.length) return false;
        return !explicitDirsSeen.has(ancestor);
      });
      if (missing) return true;
    }
    return false;
  };

  layerPaths.forEach((paths, index) => {
    for (const name of paths) {
      // Entry validation is charged work even for a root-level name with no ancestors at all.
      work.step("merged namespace entry");
      assertMemberPathBounded(name);
    }
    // This layer's ordinary entries, and every directory they sit beneath — computed ONCE, before
    // either pass, so both passes and the conflict rules see the same sets whatever the tar order.
    const entries = [];
    for (const name of paths) {
      work.step("merged namespace filter");
      if (whiteoutOf(name).kind === "none") {
        retained.membership();
        entries.push(name);
      }
    }
    const keys = new Set();
    for (const key of entries) {
      work.step("merged namespace key set");
      if (!keys.has(key)) retained.membership();
      keys.add(key);
    }
    const hasDescendantHere = new Set();
    for (const key of entries) ancestors(key, (ancestor) => {
      if (!hasDescendantHere.has(ancestor)) retained.relation(ancestor);
      hasDescendantHere.add(ancestor);
    });
    /** Keys THIS layer placed. Anything else visible is lower — no per-layer copy of the whole map. */
    const placedHere = new Set();
    const rememberPlaced = (key) => { if (!placedHere.has(key)) retained.membership(); placedHere.add(key); };
    const isLower = (key) => visible.has(key) && !placedHere.has(key);

    /**
     * B10 — THE OPAQUE MARKER'S ORDER MATTERS, so pass 1 walks the layer in TAR ORDER and remembers
     * what came before each marker.
     *
     * The pinned runtime has two extraction paths. The overlay converter keeps a same-layer descendant
     * written before an opaque marker; the non-overlay converter can REMOVE one whose intermediate
     * directory it only created implicitly, because that directory is not in its unpacked set. Rather
     * than pick a runtime, the audit records the existing `merged-type-conflict` for the ambiguous
     * shape: an earlier descendant beneath the marker's directory with an intermediate directory that
     * was never declared as its own entry before the marker.
     *
     * Supported, and deliberately NOT flagged: a marker that precedes its descendants, an earlier
     * DIRECT child (no intermediate at all), an earlier deep descendant whose whole intermediate chain
     * was declared before the marker (in any order relative to the descendant), and unrelated or
     * merely prefix-sharing siblings. The root marker keeps its own behaviour (B7).
     */
    const explicitDirsSeen = new Set();
    /** Ordinary NON-directory keys this layer has written so far, in tar order (round 10). */
    const nonDirsSeenHere = new Set();
    const earlierOrdinary = [];
    for (const name of paths) {
      const white = whiteoutOf(name);
      work.step("merged namespace marker");
      if (white.kind === "none") {
        // Ordinary entries are remembered in order, so a later marker can ask what preceded it.
        retained.membership();
        earlierOrdinary.push(name);
        if (isDirectoryKey(name)) {
          if (!explicitDirsSeen.has(name)) retained.membership();
          explicitDirsSeen.add(name);
        } else if (!nonDirsSeenHere.has(name)) {
          retained.membership();
          nonDirsSeenHere.add(name);
        }
        continue;
      }
      /**
       * THE MARKER'S OWN PARENT CHAIN (round 10). The pinned extractor prepares a member's parents
       * BEFORE it interprets a whiteout, and preparing a parent that is currently a regular file or a
       * link fails with ENOTDIR — it does not silently replace it with a directory. So a marker under a
       * non-directory cannot produce the filesystem this audit would otherwise report as complete. An
       * explicit directory entry earlier in THIS layer does replace it, and is respected; a declaration
       * after the marker does not retroactively make it valid.
       */
      if ((white.kind === "delete" || white.kind === "opaque") && markerParentConflict(name, explicitDirsSeen, nonDirsSeenHere)) {
        conflicts.add(index);
      }
      /**
       * B10 applies to the ROOT marker too (round 9). A root `.wh..wh..opq` after entries that created
       * `app/` and `app/d/` implicitly is the same ambiguity one level up: the non-overlay converter can
       * remove those undeclared directories and everything under them. Only the semantic root `.` is
       * exempt — it is never an intermediate — and B7's lower-layer emptying is unchanged.
       */
      if (white.kind === "opaque" && opaqueOrderAmbiguity(white.target, earlierOrdinary, explicitDirsSeen)) {
        conflicts.add(index);
      }
      if (white.kind === "delete") {
        const target = white.target;
        // B8: an ordinary whiteout overlapping this layer's own entry is order-dependent across
        // extractors. A similar-prefix sibling (`app/d2` for `app/.wh.d`) is not an overlap.
        if (keys.has(target) || keys.has(`${target}/`) || hasDescendantHere.has(`${target}/`)) conflicts.add(index);
        for (const existing of subtree(target)) remove(existing, index, "deleted");
      } else if (white.kind === "opaque") {
        const source = white.target === "" ? visible.keys() : (beneath.get(white.target) ?? []);
        const children = [];
        for (const key of source) {
          work.step("merged namespace opaque scan");
          if (white.target === "" && key === ".") continue;
          retained.membership();
          children.push(key);
        }
        for (const existing of children) remove(existing, index, "opaque-directory");
      }
    }

    /**
     * PASS 2 — this layer's entries, with TYPE REPLACEMENT against the layers below (B6, OCI "changeset
     * over existing files"): a non-directory at `P` replaces a lower directory `P/` and everything under
     * it; a directory at `P/` replaces a lower non-directory `P`; a directory over a directory merges.
     */
    for (const key of entries) {
      if (isDirectoryKey(key)) {
        const bare = key.slice(0, -1);
        if (keys.has(bare)) conflicts.add(index); // a file and a directory of one name in one layer
        if (isLower(bare) && !isDirectoryKey(bare)) remove(bare, index, "replaced-by-directory");
      } else {
        if (keys.has(`${key}/`) || hasDescendantHere.has(`${key}/`)) conflicts.add(index);
        for (const existing of subtree(key).slice(1)) {
          if (isLower(existing)) remove(existing, index, "replaced-by-non-directory");
        }
      }
      // Writing beneath a path a LOWER layer left as a non-directory is not a merge any extractor agrees on.
      ancestors(key, (ancestor) => {
        const bare = ancestor.slice(0, -1);
        if (isLower(bare) && !keys.has(ancestor)) conflicts.add(index);
      });
      if (visible.has(key)) remove(key, index, "overwritten");
      place(key, index);
      rememberPlaced(key);
    }
  });
  return { visible, shadowed, conflicts: Object.freeze([...conflicts].sort((a, b) => a - b)) };
}
