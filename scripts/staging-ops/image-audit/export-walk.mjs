/**
 * AIO-997 audit — walking the exported image WITHOUT trusting its index.
 *
 * THE DESIGN DECISION WORTH KNOWING. A `docker save` archive carries an index (`manifest.json`,
 * `index.json`, `oci-layout`) whose shape varies by Docker version and image store. This module
 * reads NONE of it. It hashes every member of the export once and looks the config and each layer up
 * BY DIGEST, taken from the registry manifest that was already verified against the pinned subject.
 *
 * That is not a shortcut around parsing — it is the stronger check. An index is a claim about which
 * blob is which; a hash lookup is the blob being what it says. It also makes the walk independent of
 * the export form, so "which store produced this archive" stops being a question the audit has to
 * answer correctly in order to be safe.
 *
 * MEMORY. Layers are gigabyte-scale, so nothing here buffers one. Pass 1 hashes members through
 * positioned range reads; pass 2 streams the needed member through a decompressor to a scratch file.
 * Content that goes to the scanner is written under a name THIS MODULE chose, never the archive's —
 * which is what makes a hostile member name inert rather than a path to sanitise.
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, gunzipSync } from "node:zlib";
import { bufferSource, readTarMembers } from "./tar-reader.mjs";

/** A positioned-read source over a file. No whole-file buffer exists at any point. */
export function fileSource(path) {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read(position, length) {
      if (length <= 0) return Buffer.alloc(0);
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, read);
    },
    close() { closeSync(fd); },
  };
}

/** A minimal synchronous sink, so staging a member is a plain loop rather than stream orchestration. */
function openSink(path) {
  const fd = openSync(path, "w");
  let offset = 0;
  return {
    write(chunk) {
      offset += writeSync(fd, chunk, 0, chunk.length, offset);
    },
    close() { closeSync(fd); },
  };
}

/**
 * PASS 1 — every member of the export, by content hash.
 *
 * Directories and links are skipped: a layer blob is a regular file, and a link cannot be one.
 */
export function indexExportByDigest(source, { maxMembers = 4096 } = {}) {
  const byDigest = new Map();
  for (const member of readTarMembers(source, { maxMembers })) {
    if (member.type !== "file" || member.size === 0) continue;
    const { sha256 } = member.content();
    byDigest.set(`sha256:${sha256}`, Object.freeze({ name: member.name, dataOffset: member.dataOffset, size: member.size }));
  }
  return byDigest;
}

/** Read one indexed member fully into memory. Used for the CONFIG only, which is a small JSON blob. */
export function readIndexedMember(source, entry, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (entry.size > maxBytes) {
    throw new Error(`the exported config member is ${entry.size} bytes, past the ${maxBytes}-byte limit for an in-memory read`);
  }
  return source.read(entry.dataOffset, entry.size);
}

async function streamMember(exportPath, entry, outPath, transform) {
  const hash = createHash("sha256");
  const stages = [createReadStream(exportPath, { start: entry.dataOffset, end: entry.dataOffset + entry.size - 1 })];
  if (transform) stages.push(transform());
  stages.push(async function* (chunks) {
    for await (const chunk of chunks) {
      hash.update(chunk);
      yield chunk;
    }
  });
  stages.push(createWriteStream(outPath));
  await pipeline(...stages);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * PASS 2 — stream one exported member through gunzip into a scratch file, returning the sha256 of
 * the DECOMPRESSED bytes. That value is the layer's measured diff_id candidate; `classifyLayerMember`
 * decides whether it is the right one.
 */
export function gunzipMemberToFile(exportPath, entry, outPath) {
  return streamMember(exportPath, entry, outPath, createGunzip);
}

/** Copy an already-uncompressed member out to scratch, returning its sha256 — no decode attempted. */
export function copyMemberToFile(exportPath, entry, outPath) {
  return streamMember(exportPath, entry, outPath, undefined);
}

/**
 * ONE cumulative allowance for every byte staged into `scan/`, shared by all layers.
 *
 * WHY IT IS A SHARED OBJECT rather than a per-layer number: the bound the audit needs is the total
 * size of the scratch tree, and that is a property of the run, not of any one layer. Reservation
 * happens BEFORE a write, so exhaustion is detected without first filling the disk.
 */
export function createStagingBudget(limit = Number.POSITIVE_INFINITY) {
  let used = 0;
  return {
    get used() { return used; },
    get limit() { return limit; },
    remaining() { return limit - used; },
    /** Claim `bytes` of the allowance. False means the write must not happen. */
    reserve(bytes) {
      const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
      if (used + size > limit) return false;
      used += size;
      return true;
    },
  };
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
/** Formats this audit cannot expand. Their presence is a RECORDED coverage gap, never a silent skip. */
const UNEXPANDABLE = /\.(zip|xz|bz2|br|zst|7z|rar|jar|whl|egg|deb|rpm|apk)$/i;

const looksGzip = (head) => head.length >= 2 && head.subarray(0, 2).equals(GZIP_MAGIC);
const looksTar = (head) => head.length >= 262 && head.subarray(257, 262).toString("ascii") === "ustar";

/** A filesystem-safe extension for the scanner's benefit, derived from the name but never trusted. */
function safeExtension(name) {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(name);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/**
 * Inventory ONE layer and stage its regular-file content for the scanner.
 *
 * WHAT IT RETURNS, and why each piece exists:
 *   `paths`        — every member name in order, for the merged-filesystem computation.
 *   `appMembers`   — `/app` files and symlinks with their hashes, for the inventory comparison.
 *   `staged`       — scratch id → the member's real name. PRIVATE: it is how a coordinator resolves
 *                    an occurrence id in a bounded rerun, and it is exactly what must not be
 *                    published.
 *   `limitations`  — every member this pass could not fully inspect.
 *
 * Nested archives are expanded ONE level, because a `.tar.gz` inside a layer is content that a
 * scanner pointed at opaque bytes reports as clean. Anything deeper, or in a format this module
 * cannot decode, is recorded as a limitation — which makes coverage incomplete and blocks the
 * transition until a coordinator adjudicates the recorded gap.
 */
export function inventoryLayer({ layerTarPath, layerIndex, scanDir, limits, prefix = "app/", stagingBudget }) {
  const source = fileSource(layerTarPath);
  mkdirSync(join(scanDir, `L${layerIndex}`), { recursive: true });
  const budget = stagingBudget ?? createStagingBudget(limits.maxTotalStagedBytes ?? Number.POSITIVE_INFINITY);
  const paths = [];
  const appMembers = [];
  const staged = new Map();
  const limitations = [];
  let sequence = 0;
  let expandedBytes = 0;
  let members = 0;

  /**
   * Write bytes to scratch under an id THIS module chose, and remember the real name privately.
   *
   * Returns `undefined` when the CUMULATIVE staging allowance cannot cover `bytes` — the reservation
   * happens before the sink is opened, so a refused member leaves no partial file behind for the
   * scanner to read as though it were the whole thing.
   */
  const stage = (name, emit, depth, bytes) => {
    if (!budget.reserve(bytes)) return undefined;
    const id = `L${layerIndex}/${String(sequence++).padStart(6, "0")}${safeExtension(name)}`;
    const sink = openSink(join(scanDir, id));
    try {
      emit((chunk) => sink.write(chunk));
    } finally {
      sink.close();
    }
    staged.set(id, { name, layer: layerIndex, depth });
    return id;
  };

  try {
    for (const member of readTarMembers(source, { maxMembers: limits.maxMembersPerLayer })) {
      members += 1;
      const name = member.name.replace(/^\.\//, "");
      paths.push(name);

      if (member.type === "symlink" || member.type === "hardlink") {
        // Compared AS LINKS. The target is a string here and stays one — nothing resolves it.
        if (name.startsWith(prefix)) {
          appMembers.push({ path: name, type: "symlink", linkTarget: member.linkTarget, sha256: undefined });
        }
        continue;
      }
      if (member.type !== "file") {
        // A directory/fifo/device carries no content, so passing over it costs no coverage. A member
        // whose TYPEFLAG this reader does not know is different: it may carry bytes nobody looked at,
        // and dropping it silently is the same coverage hole as skipping a file.
        if (member.type === "unsupported") {
          limitations.push({
            kind: "unsupported-member-type",
            layer: layerIndex,
            // The typeflag is one attacker-controlled byte, and limitations reach the PUBLIC evidence
            // artifact. Anything but a plain alphanumeric is reported by category, not echoed.
            typeflag: /^[A-Za-z0-9]$/.test(member.typeflag) ? member.typeflag : "non-printable",
          });
        }
        continue;
      }

      if (member.size > limits.maxMemberBytes) {
        limitations.push({ kind: "oversized-member", layer: layerIndex, bytes: member.size });
        continue;
      }
      if (expandedBytes + member.size > limits.maxExpandedBytesPerLayer) {
        limitations.push({ kind: "layer-byte-budget-exhausted", layer: layerIndex });
        break;
      }

      // ONE read of the member: hash it, stage it for the scanner, and keep its head for
      // nested-archive detection. Reading it twice would double the audit's I/O for no new evidence.
      const head = [];
      let headBytes = 0;
      let digest;
      const id = stage(name, (write) => {
        digest = member.content((chunk) => {
          if (headBytes < 512) {
            const slice = chunk.subarray(0, 512 - headBytes);
            head.push(slice);
            headBytes += slice.length;
          }
          write(chunk);
        }).sha256;
      }, 0, member.size);
      if (id === undefined) {
        // The cumulative allowance is spent. Every remaining member of this layer would be refused
        // too, so the layer stops here and says so — a partially staged layer reported as fully
        // scanned is precisely the silent narrowing this audit must not do.
        limitations.push({ kind: "total-staging-budget-exhausted", layer: layerIndex });
        break;
      }
      expandedBytes += member.size;
      if (name.startsWith(prefix)) appMembers.push({ path: name, type: "file", sha256: digest, scratchId: id });

      const headBuffer = Buffer.concat(head);
      if (UNEXPANDABLE.test(name)) {
        // Scanned as OPAQUE BYTES, which is not decoded inspection and is not reported as one.
        limitations.push({ kind: "unexpanded-archive-format", layer: layerIndex, extension: safeExtension(name) });
        continue;
      }
      if (looksGzip(headBuffer) || looksTar(headBuffer)) {
        expandNested({ member, name, layerIndex, limitations, limits, stage });
      }
    }
  } finally {
    source.close();
  }
  return { paths, appMembers, staged, limitations, members, expandedBytes };
}

/**
 * ONE level of nested expansion, bounded by `limits.maxNestedArchiveDepth`. Anything beyond it is
 * recorded rather than followed: unbounded expansion is a decompression bomb, and a silently
 * truncated one is a coverage lie.
 */
function expandNested({ member, name, layerIndex, limitations, limits, stage }) {
  if (limits.maxNestedArchiveDepth < 1) {
    limitations.push({ kind: "nested-archive-not-expanded", layer: layerIndex });
    return;
  }
  const chunks = [];
  member.content((chunk) => chunks.push(Buffer.from(chunk)));
  let bytes = Buffer.concat(chunks);
  try {
    if (looksGzip(bytes)) bytes = gunzipSync(bytes, { maxOutputLength: limits.maxMemberBytes });
    if (!looksTar(bytes)) {
      // A bare gzip of a single file. Its INFLATED bytes are what a scanner must see; the compressed
      // copy staged above is opaque to every rule.
      //
      // Expansion counts against the SAME cumulative allowance: inflated bytes occupy the same disk,
      // and a nested archive is exactly where an unbounded expansion would come from.
      if (stage(`${name}#inflated`, (write) => write(bytes), 1, bytes.length) === undefined) {
        limitations.push({ kind: "total-staging-budget-exhausted", layer: layerIndex });
      }
      return;
    }
    for (const nested of readTarMembers(bufferSource(bytes), { maxMembers: limits.maxMembersPerLayer })) {
      if (nested.type !== "file") continue;
      if (nested.size > limits.maxMemberBytes) {
        limitations.push({ kind: "oversized-nested-member", layer: layerIndex, bytes: nested.size });
        continue;
      }
      if (stage(`${name}#${nested.name}`, (write) => nested.content(write), 1, nested.size) === undefined) {
        limitations.push({ kind: "total-staging-budget-exhausted", layer: layerIndex });
        break;
      }
    }
  } catch (error) {
    // A nested archive that would not decode is a GAP, not a pass. Only the error's NAME is kept —
    // its message can quote member paths and content.
    limitations.push({ kind: "nested-archive-undecodable", layer: layerIndex, reason: error?.name ?? "Error" });
  }
}
