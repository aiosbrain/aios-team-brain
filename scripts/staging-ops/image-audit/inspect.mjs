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
import {
  copyMemberToFile,
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

  for (const [layerIndex, descriptor] of manifest.layers.entries()) {
    const diffId = config.diffIds[layerIndex];
    // Located by DIGEST, in either accepted form. A layer the export does not contain is a MISSING
    // LAYER and fails — it is not a layer with nothing in it.
    const compressed = index.get(descriptor.digest);
    const uncompressed = index.get(diffId);
    const entry = compressed ?? uncompressed;
    if (!entry) {
      throw new Error(`the export contains no member for layer ${layerIndex} (descriptor ${descriptor.digest}, diff_id ${diffId}); missing layer`);
    }
    const layerTarPath = join(layerDir, `layer-${layerIndex}.tar`);
    // The decode happens ONCE, streamed to scratch, and its measured hash is what
    // `classifyLayerMember` adjudicates. The measurement and the decision stay separate.
    const rawSha = compressed && entry === compressed ? descriptor.digest : diffId;
    const measured = compressed && entry === compressed
      ? await gunzipMemberToFile(exportPath, entry, layerTarPath)
      : await copyMemberToFile(exportPath, entry, layerTarPath);
    // The uncompressed branch never calls `decode`, so nothing downstream would notice a copy that
    // ended early. Its own re-hash is the check: the staged tar must still BE the diff_id.
    if (entry === uncompressed && entry !== compressed && measured !== diffId) {
      throw new Error(`layer ${layerIndex} staged to ${measured}, not the diff_id ${diffId} it was located by`);
    }
    const classified = classifyLayerMember({ rawSha, descriptor, diffId, decode: () => measured });

    const inventory = inventoryLayer({ layerTarPath, layerIndex, scanDir, limits });
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
      limitations: Object.freeze(limitations.map((limitation) => Object.freeze(limitation))),
    }),
    identityVerified: layers.length === manifest.layers.length && layers.every((layer) => layer.form),
  };
}

/**
 * The `/app` view the inventory comparison needs: the LAST writer of each path wins, exactly as the
 * merged filesystem would resolve it — but every earlier version was already inventoried and staged
 * for the scan by `inspectExport`. Comparison is about provenance of what ships; scanning is about
 * every byte that ships, and they are deliberately different sets.
 */
export function latestAppMembers(appMembers) {
  const latest = new Map();
  for (const member of appMembers) {
    if (member.path.includes("/.wh.")) continue;
    latest.set(member.path, member);
  }
  return [...latest.values()];
}
