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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyLayerMember,
  mergedFilesystem,
  verifyConfig,
} from "./layers.mjs";
import { LAYER_MEDIA_TYPES } from "./subject.mjs";
import {
  copyMemberToFile,
  createStagingBudget,
  fileSource,
  gunzipMemberToFile,
  indexExportByDigest,
  inventoryLayer,
  readIndexedMember,
} from "./export-walk.mjs";

/**
 * Inspect the exported image against the already-verified registry manifest.
 *
 * `manifest` MUST be the return of `verifyManifest` — i.e. bytes that hashed to the pinned subject
 * digest. Nothing here re-derives that, and nothing here would accept an export on its own say-so:
 * every blob is located by the digest the manifest declares.
 */
export async function inspectExport({ exportPath, manifest, scratchDir, limits, platform }) {
  const scanDir = join(scratchDir, "scan");
  const layerDir = join(scratchDir, "layers");
  mkdirSync(scanDir, { recursive: true });
  mkdirSync(layerDir, { recursive: true });

  const source = fileSource(exportPath);
  let index;
  let configBytes;
  try {
    index = indexExportByDigest(source);
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
  /**
   * THE CONFIG IS SCANNED CONTENT, not just metadata (PUB-03). `Env`, `Labels`, `Cmd`/`Entrypoint`
   * and every `created_by` line of the history live in these bytes — which is where a `--build-arg`
   * secret, an `ENV TOKEN=…` or a credential echoed into a `RUN` command ends up. A scan of the
   * layers alone would never see any of it, and the image ships all of it to whoever pulls the
   * digest.
   */
  writeFileSync(join(scanDir, "image-config.json"), configBytes);

  const layers = [];
  const limitations = [];
  const layerPaths = [];
  const appMembers = [];
  const staged = new Map();
  // ONE allowance for the whole scan tree, shared across every layer and every nested expansion
  // inside them (PUB-01). A per-layer bound is not a total.
  const stagingBudget = createStagingBudget(limits.maxTotalStagedBytes ?? Number.POSITIVE_INFINITY);

  for (const [layerIndex, descriptor] of manifest.layers.entries()) {
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
    const measured = compressed
      ? await gunzipMemberToFile(exportPath, entry, layerTarPath)
      : await copyMemberToFile(exportPath, entry, layerTarPath);
    // The raw-copy branch never calls `decode`, so nothing downstream would notice a copy that ended
    // early. Its own re-hash is the check: the staged tar must still BE the diff_id.
    if (!compressed && measured !== diffId) {
      throw new Error(`layer ${layerIndex} staged to ${measured}, not the diff_id ${diffId} it was located by`);
    }
    const classified = classifyLayerMember({ rawSha, descriptor, diffId, decode: () => measured });

    const inventory = inventoryLayer({ layerTarPath, layerIndex, scanDir, limits, stagingBudget });
    layerPaths.push(inventory.paths);
    appMembers.push(...inventory.appMembers.map((member) => ({ ...member, layer: layerIndex })));
    for (const [id, detail] of inventory.staged) staged.set(id, detail);
    limitations.push(...inventory.limitations);
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

  const merged = mergedFilesystem(layerPaths);
  return {
    config,
    layers: Object.freeze(layers),
    appMembers,
    merged,
    staged,
    scanDir,
    coverage: Object.freeze({
      complete: limitations.length === 0,
      layers: layers.length,
      members: layers.reduce((total, layer) => total + layer.members, 0),
      /** Bytes actually written into the scan tree, against the run's cumulative allowance. */
      stagedBytes: stagingBudget.used,
      // `Infinity` does not survive JSON, so an unbounded budget says so in words rather than
      // serializing as `null` and reading like a missing measurement.
      stagedByteLimit: Number.isFinite(stagingBudget.limit) ? stagingBudget.limit : "unbounded",
      limitations: Object.freeze(limitations.map((limitation) => Object.freeze(limitation))),
    }),
    identityVerified: layers.length === manifest.layers.length && layers.every((layer) => layer.form),
  };
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
