/**
 * AIO-997 audit — the composition: a verified manifest plus an export on disk becomes a per-layer
 * inventory, staged content for the scanner, and an honest coverage account.
 *
 * WHY THIS IS ITS OWN MODULE. It is the seam a local synthetic-image test can drive end to end
 * (PUB-07) without Docker, a registry or a network: hand it a hand-built export tar and a matching
 * manifest and it performs exactly what the runner performs. The CLI below it adds the registry,
 * the scanner and the source checkout; none of those change what this does.
 *
 * COVERAGE IS A RETURN VALUE, NOT A MOOD. Every limitation any layer hit is collected here, and
 * `complete` is false whenever there is one. A caller cannot report a clean scan of an image whose
 * content it did not finish reading.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  classifyLayerMember,
  forEachAncestor,
  mergedFilesystem,
  verifyConfig,
} from "./layers.mjs";
import { LAYER_MEDIA_TYPES } from "./subject.mjs";
import { assertMemberPathBounded } from "./tar-reader.mjs";
import { createRetainedStateBudget, createWorkBudget } from "./budgets.mjs";
import {
  copyMemberToFile,
  createStagingBudget,
  fileSource,
  gunzipMemberToFile,
  indexExportByDigest,
  inventoryLayer,
  readIndexedMember,
  stageConfig,
} from "./export-walk.mjs";
import { SCAN_HEADER, SCAN_REPRESENTATION } from "./scan-surface.mjs";

/**
 * Inspect the exported image against the already-verified registry manifest.
 *
 * `manifest` MUST be the return of `verifyManifest` — i.e. bytes that hashed to the pinned subject
 * digest. Nothing here re-derives that, and nothing here would accept an export on its own say-so:
 * every blob is located by the digest the manifest declares.
 *
 * `deadline` is PUB-01's internal budget. It is consulted between layers, inside the decode stream
 * and inside the member loop — not only around subprocesses — so a pathological export aborts with a
 * fixed code while there is still time to write the sanitized record, rather than being killed by the
 * job timeout with no artifact at all.
 */
export async function inspectExport({ exportPath, manifest, scratchDir, limits, platform, deadline }) {
  const scanDir = join(scratchDir, "scan");
  const layerDir = join(scratchDir, "layers");
  mkdirSync(scanDir, { recursive: true });
  mkdirSync(layerDir, { recursive: true });

  /**
   * The declared layer count, bounded BEFORE any decode or staging allocation (F12).
   *
   * `maxLayerCount` was recorded in the limits and consulted nowhere: a manifest declaring ten
   * thousand layers would have been walked one gunzip at a time until something else ran out. The
   * check belongs here, before the first blob is located, because that is the last moment at which
   * refusing costs nothing.
   */
  if (manifest.layers.length > limits.maxLayerCount) {
    throw Object.assign(
      new Error(`the manifest declares ${manifest.layers.length} layers, past the audit's ${limits.maxLayerCount}-layer bound`),
      { code: "AUDIT_LAYER_COUNT_EXCEEDED" },
    );
  }

  const source = fileSource(exportPath);
  let index;
  let configBytes;
  try {
    // The budget reaches PASS 1, not only the layer loop below: hashing every member of a large
    // export is real work, and it happens before anything is decoded.
    index = indexExportByDigest(source, { deadline, limits });
    const configEntry = index.get(manifest.config.digest);
    if (!configEntry) {
      // The export does not contain the config the registry manifest names. Refusing here is the
      // difference between auditing THE pinned artifact and auditing whatever was on the runner.
      throw new Error(`the export contains no member hashing to the manifest's config digest ${manifest.config.digest}`);
    }
    configBytes = readIndexedMember(source, configEntry);
  } finally {
    source.close();
  }
  const config = verifyConfig(configBytes, manifest, { platform });

  const layers = [];
  const limitations = [];
  const layerPaths = [];
  /**
   * EVERY SYMLINK LOCATION SEEN SO FAR, image-wide (B5). An extractor resolves a member's parent
   * directories inside the rootfs, following symlinks — so `side -> app` then `side/planted.js` writes
   * `/app/planted.js`, which the `/app` inventory never compares. The auditor never follows a link; it
   * records a member whose proper ancestor IS or WAS a symlink (in a lower layer, or anywhere in the
   * same layer whatever the tar order) as a blocking gap. A historical union: a link later replaced
   * still counts, which is conservative.
   */
  const symlinkLocations = new Set();
  /**
   * ONE retained-state authority and ONE work authority for the whole run (B9-R), created before the
   * first member is inventoried and shared by every layer and the merge, so the ceiling covers
   * everything held at once rather than each structure in isolation.
   */
  const retained = createRetainedStateBudget();
  const work = createWorkBudget({ deadline });
  const appMembers = [];
  const staged = new Map();
  const buildOutputs = new Map();
  let archiveSurfaceBytes = 0;
  // ONE allowance for the whole scan tree, shared across every layer and every nested expansion
  // inside them (PUB-01). A per-layer bound is not a total.
  const stagingBudget = createStagingBudget(
    limits.maxTotalStagedBytes ?? Number.POSITIVE_INFINITY,
    limits.maxScanSurfaceOverheadBytes ?? Number.POSITIVE_INFINITY,
  );

  /**
   * THE CONFIG IS SCANNED CONTENT, not just metadata (PUB-03). `Env`, `Labels`, `Cmd`/`Entrypoint`
   * and every `created_by` line of the history live in these bytes — which is where a `--build-arg`
   * secret, an `ENV TOKEN=…` or a credential echoed into a `RUN` command ends up. A scan of the
   * layers alone would never see any of it, and the image ships all of it to whoever pulls the
   * digest.
   *
   * Staged through the SAME representation as every layer member, under an id from the same closed
   * vocabulary. The fixed name it used to carry (`image-config.json`) inherited a suffix this audit
   * had not chosen from its own list, which is the identical shape of mistake F2 was about.
   */
  const configScanId = stageConfig({ scanDir, configBytes });

  for (const [layerIndex, descriptor] of manifest.layers.entries()) {
    deadline?.assert("layer inspection");
    const diffId = config.diffIds[layerIndex];
    /**
     * WHICH REPRESENTATION IS ON DISK, and therefore whether to decode — decided by the DECLARED
     * MEDIA TYPE, never by which digest the index happens to contain.
     *
     * THE BUG THIS SHAPE EXISTS FOR. For an uncompressed `…layer.v1.tar` layer the descriptor digest
     * IS the diff_id, so "the export contains a member hashing to descriptor.digest" was true for a
     * raw tar — and the code read that as proof of compression and fed a plain tar to gunzip. The
     * media type is the only thing that says how the bytes are encoded; `verifyManifest` has already
     * refused any type not in this closed map.
     */
    const codec = LAYER_MEDIA_TYPES[descriptor.mediaType];
    if (codec === "tar" && descriptor.digest !== diffId) {
      throw new Error(
        `layer ${layerIndex} declares the uncompressed ${descriptor.mediaType} but its descriptor ` +
        `${descriptor.digest} is not its diff_id ${diffId}; an uncompressed layer's blob digest and ` +
        `diff_id are the same bytes, so this manifest/config pair is inconsistent`
      );
    }
    // A gzip layer may sit in the export EITHER as the registry blob or as the already-decompressed
    // diff (which is what `docker save` writes). Both are located by hash; a layer the export does
    // not contain in either form is a MISSING LAYER and fails, not a layer with nothing in it.
    const compressed = codec === "gzip" ? index.get(descriptor.digest) : undefined;
    const uncompressed = index.get(diffId);
    const entry = compressed ?? uncompressed;
    if (!entry) {
      throw new Error(`the export contains no member for layer ${layerIndex} (descriptor ${descriptor.digest}, diff_id ${diffId}); missing layer`);
    }
    const layerTarPath = join(layerDir, `layer-${layerIndex}.tar`);
    // The decode happens ONCE, streamed to scratch, and its measured hash is what
    // `classifyLayerMember` adjudicates. The measurement and the decision stay separate.
    const rawSha = compressed ? descriptor.digest : diffId;
    // BOUNDED OUTPUT (F5). Nothing used to count the bytes leaving the decompressor before they hit
    // the disk, so a small blob that inflates enormously filled the runner before any limit was
    // consulted. A partial output is removed by `streamMember` rather than left to be read as a layer.
    const decodeOptions = { maxOutputBytes: limits.maxLayerDecodedBytes ?? Number.POSITIVE_INFINITY, deadline };
    const measured = compressed
      ? await gunzipMemberToFile(exportPath, entry, layerTarPath, decodeOptions)
      : await copyMemberToFile(exportPath, entry, layerTarPath, decodeOptions);
    // The raw-copy branch never calls `decode`, so nothing downstream would notice a copy that ended
    // early. Its own re-hash is the check: the staged tar must still BE the diff_id.
    if (!compressed && measured !== diffId) {
      throw new Error(`layer ${layerIndex} staged to ${measured}, not the diff_id ${diffId} it was located by`);
    }
    const classified = classifyLayerMember({ rawSha, descriptor, diffId, decode: () => measured });

    const inventory = inventoryLayer({ layerTarPath, layerIndex, scanDir, limits, stagingBudget, deadline, retained, work });
    // The cross-layer array of this layer's paths, kept until the merge runs.
    retained.membership();
    layerPaths.push(inventory.paths);
    for (const member of inventory.appMembers) {
      // A COPY with the layer index — its own record, charged before it is built.
      work.step("app member copy");
      retained.record(4);
      retained.string(member.path);
      appMembers.push({ ...member, layer: layerIndex });
    }
    for (const [id, detail] of inventory.staged) {
      retained.membership();
      staged.set(id, detail);
    }
    for (const [category, totals] of Object.entries(inventory.buildOutputs)) {
      const running = buildOutputs.get(category) ?? { files: 0, bytes: 0 };
      buildOutputs.set(category, { files: running.files + totals.files, bytes: running.bytes + totals.bytes });
    }
    limitations.push(...inventory.limitations);
    archiveSurfaceBytes += inventory.archiveSurfaceBytes;
    for (const link of inventory.symlinks) {
      work.step("symlink location");
      if (!symlinkLocations.has(link)) retained.path(link);
      symlinkLocations.add(link);
    }
    if (symlinkLocations.size > 0 && membersThroughSymlink(inventory.paths, symlinkLocations, deadline)) {
      limitations.push({ kind: "member-through-symlink", layer: layerIndex });
    }
    layers.push(Object.freeze({
      index: layerIndex,
      digest: descriptor.digest,
      diffId,
      mediaType: descriptor.mediaType,
      form: classified.form,
      members: inventory.members,
      expandedBytes: inventory.expandedBytes,
      limitations: inventory.limitations.length,
    }));
    // The decompressed layer tar has been fully inventoried and staged; keeping every one of them
    // would multiply the image's size on a runner disk this audit also has to bound.
    rmSync(layerTarPath, { force: true });
  }

  // The run's own clock reaches INSIDE the merge (B9), not only around it.
  const merged = mergedFilesystem(layerPaths, { deadline, retained, work });
  // Layers whose merged view extractors would not agree on (B6) — each a blocking gap.
  for (const layer of merged.conflicts) limitations.push({ kind: "merged-type-conflict", layer });
  return {
    config,
    configScanId,
    layers: Object.freeze(layers),
    appMembers,
    merged,
    staged,
    scanDir,
    /**
     * Outside-`/app` content, aggregated into the fixed categories of `BUILD_OUTPUT_CATEGORIES`
     * (F8). Counts and bytes only, and only for categories actually encountered — nothing here
     * assumes a category is present, and no path is ever named. These are provenance accounting,
     * never a scan exemption: every one of these files was staged and is scanned.
     */
    buildOutputs: Object.freeze(Object.fromEntries(
      [...buildOutputs].sort(([a], [b]) => a.localeCompare(b)).map(([category, totals]) => [category, Object.freeze(totals)]),
    )),
    coverage: Object.freeze({
      complete: limitations.length === 0,
      layers: layers.length,
      members: layers.reduce((total, layer) => total + layer.members, 0),
      /**
       * Bytes actually written into the scan tree, against the run's cumulative allowance — member
       * content AND archive surface, because both are charged to that one allowance.
       */
      stagedBytes: stagingBudget.used,
      /**
       * THE ARCHIVE SURFACE, counted on its own (AC-AUDIT-02): the non-content bytes of every decoded
       * layer and every gzip-decoded nested tar that reached the scanner. Included in `stagedBytes`.
       */
      archiveSurfaceBytes,
      // `Infinity` does not survive JSON, so an unbounded budget says so in words rather than
      // serializing as `null` and reading like a missing measurement.
      stagedByteLimit: Number.isFinite(stagingBudget.limit) ? stagingBudget.limit : "unbounded",
      /**
       * The scanner's INPUT, stated as two numbers rather than one. `stagedBytes` is the image's own
       * content; `scanSurfaceBytes` is what the scanner was actually pointed at, which is larger by
       * exactly the fixed header of every staged file. Reporting only the second would overstate how
       * much image was read; reporting only the first would hide that the scanner's input is not
       * byte-identical to the member. The representation is named so a reader can reconstruct it.
       */
      representation: SCAN_REPRESENTATION.version,
      /** The image config's own bytes — always staged, and bounded separately from the layer allowance. */
      configBytes: configBytes.length,
      scanSurfaceBytes: stagingBudget.used + configBytes.length + stagingBudget.overheadUsed + SCAN_HEADER.length,
      representationOverheadBytes: stagingBudget.overheadUsed + SCAN_HEADER.length,
      limitations: Object.freeze(limitations.map((limitation) => Object.freeze(limitation))),
    }),
    identityVerified: layers.length === manifest.layers.length && layers.every((layer) => layer.form),
  };
}

/**
 * Does any member in `paths` sit BENEATH a known symlink? Segment by segment over each path's proper
 * ancestors — a set lookup per segment, never a pairwise scan — with the clock consulted as it goes.
 * Only the canonical names are compared; no link target is ever read or resolved.
 */
export function membersThroughSymlink(paths, symlinkLocations, deadline, { deadlineEvery = 1024 } = {}) {
  let steps = 0;
  for (const path of paths) {
    // Bounded BEFORE any ancestor work, for direct callers too (B9).
    assertMemberPathBounded(path);
    // One pass over the path's separators — no repeated joins — with the clock consulted INSIDE a
    // single path as well as across paths.
    const hit = forEachAncestor(path, (ancestor) => {
      steps += 1;
      if (deadline && steps % deadlineEvery === 0) deadline.assert("symlink ancestry");
      return symlinkLocations.has(ancestor.slice(0, -1));
    });
    if (hit) return true;
  }
  return false;
}

/**
 * The `/app` view the inventory comparison needs: the members that SURVIVE into the merged
 * filesystem, resolved by the same whiteout rules an overlay uses.
 *
 * THE TWO SETS ARE DELIBERATELY DIFFERENT, and conflating them is a real bug rather than a nicety.
 * A file written in layer 0 and deleted in layer 4 is NOT part of `/app` — comparing it against the
 * Git tree would report a provenance question about a path that does not exist in the image — while
 * its bytes ARE still distributed and were already staged for the scan by `inspectExport`.
 * Provenance is about what ships as `/app`; scanning is about every byte that ships.
 *
 * `merged` is the return of `mergedFilesystem`, so "survives" is the measured result of replaying
 * every layer's whiteouts, not a guess from the member's name.
 */
export function latestAppMembers(appMembers, merged) {
  const visible = merged?.visible;
  return appMembers.filter((member) => {
    if (member.path.includes("/.wh.")) return false; // a whiteout is a deletion, not a file
    // Without a merged view there is nothing to resolve against, so fall back to "last writer wins"
    // rather than silently dropping every member.
    if (!visible) return true;
    return visible.get(member.path) === member.layer;
  });
}
