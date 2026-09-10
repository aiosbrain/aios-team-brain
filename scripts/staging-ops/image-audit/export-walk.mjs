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
 * positioned range reads; pass 2 streams the needed member through a decompressor to a scratch file,
 * under a bounded output ceiling so a decompression bomb aborts instead of filling the runner disk.
 *
 * WHAT THE SCANNER SEES. Content staged for the scanner is written under a name THIS MODULE chose —
 * never the archive's, which is what makes a hostile member name inert rather than a path to
 * sanitise — and in the fixed byte-preserving representation of `scan-surface.mjs`, which is what
 * makes the pinned scanner actually read a binary-magic member instead of silently skipping it.
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, gunzipSync } from "node:zlib";
import { bufferSource, readTarMembers } from "./tar-reader.mjs";
import { CONFIG_SCAN_GROUP, SCAN_HEADER, scanId } from "./scan-surface.mjs";

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

/**
 * The decode/copy ceiling, as a fixed code.
 *
 * THE DEFECT THIS EXISTS FOR. `gunzipMemberToFile` streamed a compressed layer through gunzip
 * straight to disk, and NOTHING between the decompressor and the filesystem counted bytes. The
 * audit's staging budget only starts counting once that decoded tar is being inventoried, so a
 * 20 KB layer blob that inflates to 200 GB filled the runner disk before a single limit was
 * consulted. The ceiling below is checked on every chunk as it flows, and a partial output is
 * removed rather than left for a later pass to read as though it were a whole layer.
 */
export class LayerOutputLimitError extends Error {
  constructor(bytes, limit) {
    super(`a layer's decoded output passed the ${limit}-byte ceiling after ${bytes} bytes`);
    this.name = "LayerOutputLimitError";
    this.code = "AUDIT_LAYER_OUTPUT_LIMIT";
  }
}

async function streamMember(exportPath, entry, outPath, transform, { maxOutputBytes = Number.POSITIVE_INFINITY, deadline } = {}) {
  const hash = createHash("sha256");
  let written = 0;
  let sinceCheck = 0;
  const stages = [createReadStream(exportPath, { start: entry.dataOffset, end: entry.dataOffset + entry.size - 1 })];
  if (transform) stages.push(transform());
  stages.push(async function* (chunks) {
    for await (const chunk of chunks) {
      written += chunk.length;
      if (written > maxOutputBytes) throw new LayerOutputLimitError(written, maxOutputBytes);
      // PUB-01's internal deadline reaches INSIDE the decode, not only around the subprocesses.
      // A 40-minute decompression that never checks the clock hits the job timeout, and a job
      // timeout produces no sanitized record at all.
      sinceCheck += chunk.length;
      if (deadline && sinceCheck >= DEADLINE_CHECK_BYTES) {
        sinceCheck = 0;
        deadline.assert("layer decode");
      }
      hash.update(chunk);
      yield chunk;
    }
  });
  stages.push(createWriteStream(outPath));
  try {
    await pipeline(...stages);
  } catch (error) {
    // A partial decode is not a layer. Removing it is what keeps "the copy ended early" from being
    // indistinguishable from "the layer was small".
    rmSync(outPath, { force: true });
    throw error;
  }
  return `sha256:${hash.digest("hex")}`;
}

/** How much decoded output may pass before the clock is consulted again. */
const DEADLINE_CHECK_BYTES = 64 * 1024 * 1024;
/** How many members may be inventoried before the clock is consulted again. */
const DEADLINE_CHECK_MEMBERS = 512;

/**
 * PASS 2 — stream one exported member through gunzip into a scratch file, returning the sha256 of
 * the DECOMPRESSED bytes. That value is the layer's measured diff_id candidate; `classifyLayerMember`
 * decides whether it is the right one.
 */
export function gunzipMemberToFile(exportPath, entry, outPath, options) {
  return streamMember(exportPath, entry, outPath, createGunzip, options);
}

/** Copy an already-uncompressed member out to scratch, returning its sha256 — no decode attempted. */
export function copyMemberToFile(exportPath, entry, outPath, options) {
  return streamMember(exportPath, entry, outPath, undefined, options);
}

/**
 * ONE cumulative allowance for every byte staged into `scan/`, shared by all layers.
 *
 * WHY IT IS A SHARED OBJECT rather than a per-layer number: the bound the audit needs is the total
 * size of the scratch tree, and that is a property of the run, not of any one layer. Reservation
 * happens BEFORE a write, so exhaustion is detected without first filling the disk.
 *
 * TWO COUNTERS, DELIBERATELY. `content` is the members' own bytes — the number that means "how much
 * of the image did we stage", and the one a coverage reader cares about. `overhead` is the fixed
 * per-file header of the scan representation, which occupies real disk but is not image content.
 * Folding them into one total would make the coverage figure drift with the number of files, and
 * leaving the overhead unbounded would let 32 million tiny members quietly add three quarters of a
 * gigabyte nobody budgeted for.
 */
export function createStagingBudget(limit = Number.POSITIVE_INFINITY, overheadLimit = Number.POSITIVE_INFINITY) {
  let content = 0;
  let overhead = 0;
  /**
   * WHICH counter refused the last reservation. A caller that only knows "the write did not happen"
   * cannot record WHY, and "the image was too big to stage" and "the representation ran out of its own
   * allowance" are different gaps with different remedies. Inferring it from the remaining figures
   * would be wrong in the case where content remains but not enough of it.
   */
  let lastRefusal;
  const claim = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return {
    get used() { return content; },
    get overheadUsed() { return overhead; },
    get limit() { return limit; },
    get overheadLimit() { return overheadLimit; },
    get lastRefusal() { return lastRefusal; },
    remaining() { return limit - content; },
    /** Claim `bytes` of content plus `overheadBytes` of representation. False means no write happens. */
    reserve(bytes, overheadBytes = 0) {
      const size = claim(bytes);
      const extra = claim(overheadBytes);
      if (content + size > limit) {
        lastRefusal = "content";
        return false;
      }
      if (overhead + extra > overheadLimit) {
        lastRefusal = "overhead";
        return false;
      }
      content += size;
      overhead += extra;
      lastRefusal = undefined;
      return true;
    },
  };
}

/** The limitation kind for a refused staging reservation, from the counter that actually refused it. */
const exhaustionKind = (budget) => (budget.lastRefusal === "overhead"
  ? "scan-surface-overhead-exhausted"
  : "total-staging-budget-exhausted");

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
/**
 * Formats this audit cannot expand. Their presence is a RECORDED coverage gap, never a silent skip —
 * at EVERY depth, which is the whole of F3: the top-level member loop tested this and the nested loop
 * did not, so a `.zip` one level inside a `.tar.gz` was staged as opaque bytes and contributed no
 * limitation at all.
 */
const UNEXPANDABLE = /\.(zip|xz|bz2|br|zst|7z|rar|jar|whl|egg|deb|rpm|apk)$/i;

const looksGzip = (head) => head.length >= 2 && head.subarray(0, 2).equals(GZIP_MAGIC);
const looksTar = (head) => head.length >= 262 && head.subarray(257, 262).toString("ascii") === "ustar";
/** Would this member need expanding to be inspected at all? Magic first, then the closed name list. */
const looksArchive = (head, name) => looksGzip(head) || looksTar(head) || UNEXPANDABLE.test(name);

/**
 * The format of an unexpandable member, taken from THE CLOSED LIST ABOVE rather than from the name.
 *
 * A limitation reaches the PUBLIC artifact. Deriving this from `/\.([A-Za-z0-9]{1,12})$/` on the
 * member's own name emitted twelve attacker-chosen characters; taking the capture group of the fixed
 * pattern can only ever emit one of its thirteen alternatives.
 */
function unexpandableFormat(name) {
  const match = UNEXPANDABLE.exec(name);
  return match ? `.${match[1].toLowerCase()}` : undefined;
}

/**
 * WHAT AN OUTSIDE-`/app` FILE IS, in fixed categories (PUB-03, F8).
 *
 * These are PROVENANCE ACCOUNTING, exactly like `node_modules` inside `/app`: they explain why a
 * path exists without a Git blob behind it. They confer NO scan exemption — every one of these files
 * is staged and scanned like any other — and no category is ever assumed present. Only categories
 * actually encountered appear in the evidence, as counts and byte totals; the paths themselves stay
 * in private scratch, because a base image's file list is not something this artifact needs to name.
 *
 * Order matters: the first match wins, and the last entry is the honest catch-all rather than a
 * claim that everything else was identified.
 */
export const BUILD_OUTPUT_CATEGORIES = Object.freeze([
  { category: "npm-log", test: (path) => /(^|\/)\.npm\/_logs\//.test(path) || /(^|\/)npm-debug\.log/.test(path) },
  { category: "npm-cache", test: (path) => /(^|\/)\.npm\//.test(path) || /(^|\/)\.cache\/(npm|node)\//.test(path) },
  { category: "apt-cache", test: (path) => /^var\/(lib\/apt|cache\/apt)\//.test(path) },
  { category: "apt-keyring", test: (path) => /^(usr\/share\/keyrings\/|etc\/apt\/keyrings\/|etc\/apt\/trusted\.gpg)/.test(path) },
  { category: "base-image-content", test: () => true },
]);

export function buildOutputCategory(path) {
  return BUILD_OUTPUT_CATEGORIES.find(({ test }) => test(path)).category;
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
 *   `buildOutputs` — outside-`/app` files aggregated into fixed categories, counts and bytes only.
 *   `limitations`  — every member this pass could not fully inspect.
 *
 * Nested archives are expanded to `limits.maxNestedArchiveDepth`, because a `.tar.gz` inside a layer
 * is content that a scanner pointed at opaque bytes reports as clean. EVERY expanded member is then
 * reclassified by the same rules as a top-level one — deeper archive, unexpandable format, oversized,
 * unsupported type — so a gap at depth 2 is recorded exactly like a gap at depth 0, which makes
 * coverage incomplete and blocks the transition until a coordinator adjudicates it.
 */
export function inventoryLayer({ layerTarPath, layerIndex, scanDir, limits, prefix = "app/", stagingBudget, deadline }) {
  const source = fileSource(layerTarPath);
  mkdirSync(join(scanDir, `L${layerIndex}`), { recursive: true });
  const budget = stagingBudget ?? createStagingBudget(limits.maxTotalStagedBytes ?? Number.POSITIVE_INFINITY);
  const paths = [];
  const appMembers = [];
  const staged = new Map();
  const limitations = [];
  const buildOutputs = new Map();
  let sequence = 0;
  let expandedBytes = 0;
  let members = 0;

  /**
   * Write bytes to scratch under an id THIS module chose, in the fixed scan representation, and
   * remember the real name privately.
   *
   * Returns `undefined` when the CUMULATIVE allowance cannot cover `bytes` — the reservation happens
   * before the sink is opened, so a refused member leaves no partial file behind for the scanner to
   * read as though it were the whole thing.
   *
   * THE ID CARRIES NO INHERITED SUFFIX. It used to end in `safeExtension(member.name)`, which handed
   * the scanner's default global path allowlist the one thing it keys on: byte-identical plaintext
   * staged as `.bin` and `.svg` was skipped while the same bytes as `.txt` were found.
   */
  const stage = (name, emit, depth, bytes) => {
    if (!budget.reserve(bytes, SCAN_HEADER.length)) return undefined;
    const id = scanId(`L${layerIndex}`, sequence++);
    const sink = openSink(join(scanDir, id));
    try {
      // The header FIRST, then the member's exact bytes. The suffix of the staged file is therefore
      // the original member, byte for byte — asserted directly by the representation test.
      sink.write(SCAN_HEADER);
      emit((chunk) => sink.write(chunk));
    } finally {
      sink.close();
    }
    staged.set(id, { name, layer: layerIndex, depth });
    return id;
  };

  const countBuildOutput = (name, bytes) => {
    const category = buildOutputCategory(name);
    const totals = buildOutputs.get(category) ?? { files: 0, bytes: 0 };
    totals.files += 1;
    totals.bytes += bytes;
    buildOutputs.set(category, totals);
  };

  try {
    for (const member of readTarMembers(source, { maxMembers: limits.maxMembersPerLayer })) {
      members += 1;
      if (deadline && members % DEADLINE_CHECK_MEMBERS === 0) deadline.assert("layer inventory");
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
        // The cumulative allowance cannot cover this member, so the layer STOPS rather than
        // continuing to stage whichever later members happen to be small enough to squeeze in — a
        // coverage story that depends on member order is not one a coordinator can reason about.
        // Either way the gap is recorded, which is what makes coverage incomplete.
        limitations.push({ kind: exhaustionKind(budget), layer: layerIndex });
        break;
      }
      expandedBytes += member.size;
      if (name.startsWith(prefix)) appMembers.push({ path: name, type: "file", sha256: digest, scratchId: id });
      else countBuildOutput(name, member.size);

      classifyExpanded({
        head: Buffer.concat(head),
        name,
        depth: 0,
        read: (sink) => member.content(sink),
        context: { layerIndex, limitations, limits, stage, deadline, budget },
      });
    }
  } finally {
    source.close();
  }
  return {
    paths,
    appMembers,
    staged,
    limitations,
    members,
    expandedBytes,
    buildOutputs: Object.fromEntries([...buildOutputs].map(([category, totals]) => [category, Object.freeze({ ...totals })])),
  };
}

/**
 * Stage the image CONFIG through the SAME representation as every layer member (PUB-03).
 *
 * The config carries `Env`, `Labels`, `Cmd`/`Entrypoint` and every `created_by` history line — the
 * place a `--build-arg` secret or an `ENV TOKEN=…` actually lands. It used to be written as
 * `image-config.json`, an id whose suffix the audit did not choose from its own closed vocabulary;
 * routing it through the same neutral id and the same header keeps ONE representation to reason
 * about rather than two, and keeps the config inside the same measured scan surface.
 *
 * DELIBERATELY NOT CHARGED TO THE STAGING BUDGET. The config is bounded elsewhere — `readIndexedMember`
 * refuses one past 8 MiB — and it is not optional content the audit may choose to skip. Making it
 * compete with the layer allowance would mean a tight budget silently dropped the one file that
 * carries `Env` and the build history, which is the opposite of what a bound is for. Its bytes are
 * reported as their own coverage figure instead.
 */
export function stageConfig({ scanDir, configBytes }) {
  mkdirSync(join(scanDir, CONFIG_SCAN_GROUP), { recursive: true });
  const id = scanId(CONFIG_SCAN_GROUP, 0);
  const sink = openSink(join(scanDir, id));
  try {
    sink.write(SCAN_HEADER);
    sink.write(configBytes);
  } finally {
    sink.close();
  }
  return id;
}

/**
 * Reclassify ONE staged member — at any depth — and expand it if this audit can.
 *
 * Everything F3 was about lives here. The top-level loop used to run these tests and the nested loop
 * did not, so `layer → outer.tgz → inner.tgz → sentinel.txt` staged two opaque `.tgz` blobs, recorded
 * ZERO limitations, and returned `coverage.complete === true` over content nobody decoded. The tests
 * are now one function called from both places, which is the only structural way the two cannot
 * drift apart again.
 */
function classifyExpanded({ head, name, depth, read, context }) {
  const { layerIndex, limitations, limits } = context;
  const at = depth > 0 ? { depth } : {};
  const format = unexpandableFormat(name);
  if (format !== undefined) {
    // Scanned as OPAQUE BYTES, which is not decoded inspection and is not reported as one.
    limitations.push({ kind: "unexpanded-archive-format", layer: layerIndex, extension: format, ...at });
    return;
  }
  if (!looksGzip(head) && !looksTar(head)) return; // an ordinary file: already staged, nothing to expand
  if (depth + 1 > limits.maxNestedArchiveDepth) {
    // The bound, recorded rather than followed. Unbounded expansion is a decompression bomb and a
    // silently truncated one is a coverage lie, so the only honest third option is to say so.
    limitations.push({ kind: "nested-archive-depth-limit", layer: layerIndex, depth: depth + 1 });
    return;
  }
  const chunks = [];
  read((chunk) => chunks.push(Buffer.from(chunk)));
  expandArchive({ bytes: Buffer.concat(chunks), name, depth: depth + 1, context });
}

/**
 * Expand ONE archive's bytes at `depth`, staging every regular file it contains and reclassifying
 * each of them.
 *
 * BOUNDED THREE WAYS, and none of them is "we hope archives are shallow": the depth limit above (a
 * member that would need depth+1 is recorded, not followed), the per-member size limit, and the
 * shared staging budget, which the inflated bytes charge against exactly like layer content.
 */
function expandArchive({ bytes, name, depth, context }) {
  const { layerIndex, limitations, limits, stage, deadline, budget } = context;
  const at = { depth };
  deadline?.assert("nested archive expansion");
  try {
    let data = bytes;
    if (looksGzip(data)) data = gunzipSync(data, { maxOutputLength: limits.maxMemberBytes });
    if (!looksTar(data)) {
      // A bare gzip of a single file. Its INFLATED bytes are what a scanner must see; the compressed
      // copy staged by the caller is opaque to every rule.
      //
      // Expansion counts against the SAME cumulative allowance: inflated bytes occupy the same disk,
      // and a nested archive is exactly where an unbounded expansion would come from.
      const inflatedName = `${name}#inflated`;
      if (stage(inflatedName, (write) => write(data), depth, data.length) === undefined) {
        limitations.push({ kind: exhaustionKind(budget), layer: layerIndex, ...at });
        return;
      }
      // …and the inflated bytes are themselves reclassified. A doubly-gzipped file is not a rare
      // shape, and stopping here would reintroduce the exact gap one level down.
      classifyExpanded({ head: data.subarray(0, 512), name: inflatedName, depth, read: (sink) => sink(data), context });
      return;
    }
    for (const nested of readTarMembers(bufferSource(data), { maxMembers: limits.maxMembersPerLayer })) {
      if (nested.type === "symlink" || nested.type === "hardlink" || nested.type === "directory") continue;
      if (nested.type !== "file") {
        // Same reasoning as the top-level loop: an unknown typeflag may carry bytes nobody read.
        limitations.push({
          kind: "unsupported-member-type",
          layer: layerIndex,
          typeflag: /^[A-Za-z0-9]$/.test(nested.typeflag) ? nested.typeflag : "non-printable",
          ...at,
        });
        continue;
      }
      if (nested.size > limits.maxMemberBytes) {
        limitations.push({ kind: "oversized-nested-member", layer: layerIndex, bytes: nested.size, ...at });
        continue;
      }
      const nestedName = `${name}#${nested.name}`;
      const chunks = [];
      if (stage(nestedName, (write) => nested.content((chunk) => { chunks.push(Buffer.from(chunk)); write(chunk); }), depth, nested.size) === undefined) {
        limitations.push({ kind: exhaustionKind(budget), layer: layerIndex, ...at });
        break;
      }
      const nestedBytes = Buffer.concat(chunks);
      classifyExpanded({
        head: nestedBytes.subarray(0, 512),
        name: nestedName,
        depth,
        read: (sink) => sink(nestedBytes),
        context,
      });
    }
  } catch (error) {
    if (error?.code === "STAGING_OPERATION_TIMEOUT") throw error;
    // A nested archive that would not decode is a GAP, not a pass. Only the error's NAME is kept —
    // its message can quote member paths and content.
    limitations.push({ kind: "nested-archive-undecodable", layer: layerIndex, reason: error?.name ?? "Error", ...at });
  }
}
