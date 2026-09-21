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
import { TarFormatError, bufferSource, isChecksumValidTarHeader, readTarMembers } from "./tar-reader.mjs";
import { AUDIT_LIMITS } from "./subject.mjs";
import { whiteoutOf } from "./layers.mjs";
import { ARCHIVE_SURFACE_CATEGORY, CONFIG_SCAN_GROUP, SCAN_HEADER, archiveSurfaceGroup, scanId } from "./scan-surface.mjs";

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
 *
 * THE CLOCK REACHES HERE TOO (F11). This pass HASHES every member of a multi-gigabyte export before
 * the first layer is decoded, and it used to take no deadline at all: an export pathological enough
 * to spend the whole budget in pass 1 ran past the job timeout, and a job timeout produces no
 * sanitized record. The entry assert is what makes an already-exhausted budget abort at the first
 * thing the inspection does rather than after a full walk; the periodic one bounds the walk itself.
 */
export function indexExportByDigest(source, { maxMembers = 4096, deadline, limits } = {}) {
  const byDigest = new Map();
  let members = 0;
  deadline?.assert("export index");
  /**
   * THE OUTER EXPORT GETS THE SAME STRUCTURAL RULES as every layer (AC-AUDIT-03), with one
   * difference: it has no scan surface of its own, so a non-zero trailer cannot be "scanned as opaque
   * bytes" and is REFUSED. A structural failure here refuses the whole run with a fixed code.
   */
  for (const member of readTarMembers(source, { maxMembers, ...tarReaderOptions(limits, deadline), nonzeroTrailer: "refuse" })) {
    members += 1;
    if (deadline && members % DEADLINE_CHECK_MEMBERS === 0) deadline.assert("export index");
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
 * The reader's metadata and header bounds, from the run's reviewed limits (AC-AUDIT-04). Absent keys
 * fall back to the reader's own reviewed defaults, never to "unbounded".
 */
export function tarReaderOptions(limits = {}, deadline) {
  return {
    ...(limits.maxTarMetadataRecordBytes !== undefined ? { maxMetadataRecordBytes: limits.maxTarMetadataRecordBytes } : {}),
    ...(limits.maxTarPendingMetadataBytes !== undefined ? { maxPendingMetadataBytes: limits.maxTarPendingMetadataBytes } : {}),
    ...(limits.maxTarPhysicalHeadersPerLayer !== undefined ? { maxPhysicalHeaders: limits.maxTarPhysicalHeadersPerLayer } : {}),
    deadline,
  };
}

/** How much archive surface may be copied before the clock is consulted again. */
const SURFACE_COPY_CHUNK_BYTES = 1024 * 1024;

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
 * Formats this audit cannot expand, BY NAME. Their presence is a RECORDED coverage gap, never a
 * silent skip — at EVERY depth, which is the whole of F3: the top-level member loop tested this and
 * the nested loop did not, so a `.zip` one level inside a `.tar.gz` was staged as opaque bytes and
 * contributed no limitation at all.
 *
 * KEPT ALONGSIDE the magic table below rather than replaced by it. A name is the weaker signal and
 * is the one an attacker chooses, but it is not redundant: brotli has no magic number at all, and
 * `.jar`/`.whl`/`.egg`/`.apk` are ZIPs whose NAME is the more useful thing to report to a reader.
 */
const UNEXPANDABLE = /\.(zip|xz|bz2|br|zst|7z|rar|jar|whl|egg|deb|rpm|apk)$/i;

/**
 * Container formats this audit cannot expand, recognised by the MAGIC AT THE START OF CONTENT.
 *
 * THE DEFECT THIS EXISTS FOR. `UNEXPANDABLE` above is a FILENAME test, and a filename is the one
 * property of a member that survives nothing. An independent probe gzipped a deflated ZIP as
 * `app/payload.zip.gz`: the bare-gzip branch inflated it, staged the ZIP bytes under the synthetic
 * name `…#inflated`, and reclassified THAT — a name the end-anchored `.zip` pattern cannot match. The
 * ZIP bytes are neither gzip nor tar, so classification fell through to "an ordinary file", no
 * limitation was recorded anywhere, and `inspectExport` returned `coverage.complete === true` over a
 * container whose decoded content reached no scan surface. An extensionless or renamed ZIP at the top
 * level had the identical hole, one step shorter.
 *
 * Magic is checked at EVERY classification point (top-level members, every member of a nested tar,
 * and the inflated payload of a bare gzip), because that is the only place all three meet.
 *
 * THE LABEL IS FROM THIS LIST, never from the content or the name. A limitation reaches the PUBLIC
 * artifact; `format` can only ever be one of the eight strings below.
 *
 * NOT A DECOMPRESSOR, deliberately. Recognising the container is what makes the gap HONEST — an
 * expander for each of these would be a new parser per format, and a coverage gap that is recorded
 * blocks the transition just as effectively as content that was read.
 */
const UNSUPPORTED_MAGIC = Object.freeze([
  // Local file header, end-of-central-directory (an empty archive), and the spanned/split marker.
  { format: "zip", signatures: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]] },
  { format: "xz", signatures: [[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]] },
  // `BZh` AND the block-size digit `1`-`9`, which a real stream always carries. With three bytes
  // only, any file whose content opened with the letters `BZh` — prose about bzip2, for instance —
  // was labelled an unexpandable container: fail-closed rather than a coverage hole, but a wrong
  // label, and a limitation that fires on ordinary content stops meaning anything. Nine fixed
  // signatures rather than a byte RANGE, because the matcher below compares fixed bytes and one
  // range would be a second kind of entry for every reader of this table to hold in mind.
  { format: "bzip2", signatures: Array.from({ length: 9 }, (_, index) => [0x42, 0x5a, 0x68, 0x31 + index]) },
  { format: "zstd", signatures: [[0x28, 0xb5, 0x2f, 0xfd]] },
  { format: "7z", signatures: [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]] },
  { format: "rar", signatures: [[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]] },
  { format: "ar", signatures: [[0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]] },
  { format: "rpm", signatures: [[0xed, 0xab, 0xee, 0xdb]] },
].map(({ format, signatures }) => Object.freeze({
  format,
  signatures: Object.freeze(signatures.map((bytes) => Buffer.from(bytes))),
})));

/**
 * The closed vocabulary itself, exported so a CONSUMER of a recorded limitation can validate the
 * label against the same list that produces it rather than against a copy that can drift.
 */
export const UNSUPPORTED_FORMATS = Object.freeze(UNSUPPORTED_MAGIC.map(({ format }) => format));

/**
 * The unexpandable CONTAINER a member's own first bytes declare, or `undefined`.
 *
 * START OF CONTENT ONLY. A file that happens to carry `PK\x03\x04` a hundred bytes in is an ordinary
 * file — a substring test would report a coverage gap for any source file quoting a signature, and a
 * limitation that fires on ordinary content stops meaning anything.
 */
export function unsupportedMagicFormat(head) {
  if (!Buffer.isBuffer(head) || head.length === 0) return undefined;
  for (const { format, signatures } of UNSUPPORTED_MAGIC) {
    for (const signature of signatures) {
      if (head.length >= signature.length && head.subarray(0, signature.length).equals(signature)) return format;
    }
  }
  return undefined;
}

const looksGzip = (head) => head.length >= 2 && head.subarray(0, 2).equals(GZIP_MAGIC);
const looksUstar = (head) => head.length >= 262 && head.subarray(257, 262).toString("ascii") === "ustar";

/**
 * How many leading bytes of a member every classification point keeps. Two tar blocks: enough for the
 * ustar magic at offset 257 AND for the canonical empty archive's two zero blocks.
 */
const CLASSIFY_HEAD_BYTES = 1024;

/**
 * THE ONE TAR-CANDIDATE PREDICATE, shared by the raw member, the gzip-decoded payload and every
 * recursive level — so the three cannot disagree about what "is a tar" (AC-AUDIT-02/03) — and built on
 * the READER's own first-header rule (`isChecksumValidTarHeader`), so recogniser and parser do not
 * disagree either: anything the reader would read is tried, and the reader stays the authority.
 *
 * THE DEFECT IT CLOSES. Only the ustar magic was tested, so a canonical EMPTY tar (1,024 zero bytes,
 * which has no magic) was an "ordinary file" — and bytes appended after its end blocks, a gzip stream,
 * a ZIP or a second tar, were staged opaque and reported as complete coverage. Two zero blocks at the
 * start are now a tar candidate, which the reader then holds to its structural rules (a non-zero
 * trailer is a recorded gap; zero padding is a complete, empty archive).
 */
export function isTarCandidate(head) {
  if (!Buffer.isBuffer(head)) return false;
  if (looksUstar(head)) return true;
  // A magic-less (V7) header the READER would accept is a tar here too (B1): the same checksum rule,
  // exported from the reader, over the first bounded block.
  if (isChecksumValidTarHeader(head)) return true;
  return head.length >= CLASSIFY_HEAD_BYTES && head.subarray(0, CLASSIFY_HEAD_BYTES).every((byte) => byte === 0);
}

/**
 * A NAME THAT DECLARES A TAR. `.tar`, `.tgz` and `.tar.gz` must parse as a tar even without magic, so a
 * short or malformed archive under an explicit tar name is a recorded `nested-archive-undecodable` gap
 * instead of a plain file nobody expanded. An ordinary `.gz` carries no such intent and may inflate to
 * plaintext.
 */
const TAR_INTENT = /\.(?:tar|tgz|tar\.gz)$/i;
/**
 * `looksArchive(head, name)` USED TO LIVE HERE and had no caller — the one decision it described
 * ("would this member need expanding at all") is made by `classifyExpanded` below, in the order the
 * limitation vocabulary requires: name first, then magic, then the two formats this audit CAN open.
 * A second predicate answering the same question from a different combination of the same tests is
 * how the two drift apart, and a reader of a security-relevant module is entitled to assume the
 * function they are reading is the one that runs.
 */

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
/**
 * `readerTuning` is the reader's chunk size and clock interval (`chunkBytes`, `deadlineEveryBytes`),
 * applied to member content, archive-surface staging and nested expansion alike. Production passes
 * nothing and gets the reviewed defaults; it exists so a test can drive expiry and the partial-file
 * cleanup through THIS code path without staging tens of megabytes.
 */
export function inventoryLayer({ layerTarPath, layerIndex, scanDir, limits, prefix = "app/", stagingBudget, deadline, readerTuning = {} }) {
  const source = fileSource(layerTarPath);
  mkdirSync(join(scanDir, `L${layerIndex}`), { recursive: true });
  const budget = stagingBudget ?? createStagingBudget(limits.maxTotalStagedBytes ?? Number.POSITIVE_INFINITY);
  const paths = [];
  /** Canonical locations of EVERY symlink in this layer, inside `/app` or not (B5). Never resolved. */
  const symlinks = [];
  const appMembers = [];
  const staged = new Map();
  const limitations = [];
  const buildOutputs = new Map();
  let sequence = 0;
  let expandedBytes = 0;
  let members = 0;
  let malformedWhiteoutRecorded = false;
  let rootReplacedRecorded = false;

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
    const path = join(scanDir, id);
    const sink = openSink(path);
    try {
      // The header FIRST, then the member's exact bytes. The suffix of the staged file is therefore
      // the original member, byte for byte — asserted directly by the representation test.
      sink.write(SCAN_HEADER);
      emit((chunk) => sink.write(chunk));
    } catch (error) {
      // A PARTIAL staged file is not a member (AC-AUDIT-04): an emitter that threw part-way — a
      // deadline, a short read, a structural refusal — must not leave a truncated copy in the scan
      // tree for the scanner to read as though it were the whole thing.
      sink.close();
      rmSync(path, { force: true });
      throw error;
    }
    sink.close();
    staged.set(id, { name, layer: layerIndex, depth });
    return id;
  };

  let surfaceSequence = 0;
  let archiveSurfaceBytes = 0;
  // The reviewed bound when a caller's limits omit it — never "unbounded", which would let one range
  // of any size become one staged file.
  const surfaceFileLimit = limits.maxArchiveSurfaceFileBytes ?? AUDIT_LIMITS.maxArchiveSurfaceFileBytes;
  const surfaceCheckBytes = readerTuning.deadlineEveryBytes ?? DEADLINE_CHECK_BYTES;
  const readerOptions = { ...tarReaderOptions(limits, deadline), ...readerTuning };
  mkdirSync(join(scanDir, archiveSurfaceGroup(layerIndex)), { recursive: true });

  /**
   * THE ARCHIVE SURFACE (AC-AUDIT-02): every byte of a decoded tar that is not a regular member's
   * content — headers, PAX and GNU metadata, link targets, padding, unsupported-member bodies, the
   * end-of-archive blocks and trailing bytes — staged for the scanner as a COMPLEMENT to member
   * content, never by duplicating the whole layer.
   *
   * THE SHAPE OF A SURFACE FILE. The fixed scan header, then whole ranges in archive order, packed
   * until the next range would pass `maxArchiveSurfaceFileBytes`. A range is NEVER split across files:
   * a credential cut in two is a credential no rule matches, so a range too large for one file is a
   * recorded `archive-surface-range-unstageable` limitation rather than an invented split. Ranges are
   * packed without separators; the join between two ranges can only ADD a spurious match, never hide
   * one inside a range.
   *
   * NAMED BY THE AUDIT, ATTRIBUTED BY CATEGORY. Files live under `L<n>/M/`, so a finding keeps its
   * layer; their private `staged` entry carries the fixed `archive-metadata` category and NO archive
   * name, so nothing about them can become a public path.
   *
   * CHARGED LIKE CONTENT: to the run's total staging allowance, the representation overhead (one header
   * per file), and the layer's expanded-byte budget. Any refusal is a recorded limitation.
   *
   * One stager per archive, so a failure inside a nested archive discards only its own partial file.
   */
  const createSurfaceStager = ({ source: surfaceSource, depth }) => {
    const at = depth > 0 ? { depth } : {};
    let current;
    let stopped = false;
    let sinceCheck = 0;
    const close = () => {
      if (current) current.sink.close();
      current = undefined;
    };
    return {
      stage(range) {
        if (stopped) return;
        if (range.length > surfaceFileLimit) {
          limitations.push({ kind: "archive-surface-range-unstageable", layer: layerIndex, ...at });
          return;
        }
        if (expandedBytes + range.length > limits.maxExpandedBytesPerLayer) {
          limitations.push({ kind: "layer-byte-budget-exhausted", layer: layerIndex, ...at });
          stopped = true;
          close();
          return;
        }
        const fits = current !== undefined && current.bytes + range.length <= surfaceFileLimit;
        if (!fits) close();
        if (!budget.reserve(range.length, fits ? 0 : SCAN_HEADER.length)) {
          limitations.push({ kind: exhaustionKind(budget), layer: layerIndex, ...at });
          stopped = true;
          close();
          return;
        }
        if (!fits) {
          const id = scanId(archiveSurfaceGroup(layerIndex), surfaceSequence++);
          const path = join(scanDir, id);
          current = { id, path, sink: openSink(path), bytes: 0 };
          current.sink.write(SCAN_HEADER);
          staged.set(id, { category: ARCHIVE_SURFACE_CATEGORY, layer: layerIndex, depth });
        }
        try {
          let copied = 0;
          while (copied < range.length) {
            const chunk = surfaceSource.read(range.offset + copied, Math.min(readerTuning.chunkBytes ?? SURFACE_COPY_CHUNK_BYTES, range.length - copied));
            if (chunk.length === 0) throw new TarFormatError("tar archive surface ended early");
            current.sink.write(chunk);
            copied += chunk.length;
            // Cumulative across calls: thousands of small header ranges are as much work as one big one.
            sinceCheck += chunk.length;
            if (deadline && sinceCheck >= surfaceCheckBytes) {
              sinceCheck = 0;
              deadline.assert("archive surface staging");
            }
          }
        } catch (error) {
          // The partial file goes, and so does its private entry: nothing half-written is scanned.
          const { id, path } = current;
          close();
          rmSync(path, { force: true });
          staged.delete(id);
          throw error;
        }
        current.bytes += range.length;
        archiveSurfaceBytes += range.length;
        expandedBytes += range.length;
      },
      close,
    };
  };

  const countBuildOutput = (name, bytes) => {
    const category = buildOutputCategory(name);
    const totals = buildOutputs.get(category) ?? { files: 0, bytes: 0 };
    totals.files += 1;
    totals.bytes += bytes;
    buildOutputs.set(category, totals);
  };

  const layerSurface = createSurfaceStager({ source, depth: 0 });
  try {
    for (const member of readTarMembers(source, {
      maxMembers: limits.maxMembersPerLayer,
      ...readerOptions,
      onSurface: (range) => layerSurface.stage(range),
      nonzeroTrailer: "surface",
      /**
       * NON-ZERO BYTES AFTER THE END MARKER are staged as opaque surface, but opaque is not decoded:
       * a gzip stream, a ZIP or a second tar there reaches no expansion. So it is also a recorded gap
       * that blocks. Real layers carry zero-only padding there, so this costs no false positives.
       */
      onNonzeroTrailer: () => limitations.push({ kind: "archive-trailer-nonzero", layer: layerIndex }),
    })) {
      members += 1;
      if (deadline && members % DEADLINE_CHECK_MEMBERS === 0) deadline.assert("layer inventory");
      // THE CANONICAL PATH (B2) is what the inventory, whiteouts, categories and public lookup compare.
      // An unsafe name has none; it keeps its raw spelling here and is recorded as a gap just below.
      const name = member.canonicalName ?? member.name;
      paths.push(name);
      /**
       * AN UNSAFE NAME IS A GAP, never a silent inventory omission. An absolute, traversing, NUL-bearing
       * or empty member name does not start with the `/app` prefix the inventory compares, so it would
       * simply not be compared — while an extractor may still write it somewhere. Its content is staged
       * and scanned as usual; the record says the inventory could not account for it.
       */
      if (!member.path.safe) limitations.push({ kind: "unsafe-member-path", layer: layerIndex });
      if (member.type === "symlink") symlinks.push(name);
      /**
       * A WHITEOUT MARKER THAT IS NOT AN EMPTY REGULAR FILE (B6). OCI permits only that form; extractors
       * still act on a directory-, link- or content-bearing marker by its basename. The merge applies it
       * the way they would, and the record says it was malformed — once per layer.
       */
      const whiteout = whiteoutOf(name).kind;
      // …and an ordinary marker naming nothing, `.` or `..` (L6), which deletes nothing here.
      if ((whiteout === "malformed" || (whiteout !== "none" && (member.type !== "file" || member.size !== 0))) && !malformedWhiteoutRecorded) {
        malformedWhiteoutRecorded = true;
        limitations.push({ kind: "malformed-whiteout", layer: layerIndex });
      }
      /**
       * THE INVENTORY ROOT AS A NON-DIRECTORY (B6). A file or link named exactly `app` replaces the
       * directory the inventory compares; the merge then reports every `/app` file missing, and this
       * records why — once per layer.
       */
      if (name === prefix.replace(/\/$/, "") && member.type !== "directory" && !rootReplacedRecorded) {
        rootReplacedRecorded = true;
        limitations.push({ kind: "inventory-root-not-directory", layer: layerIndex });
      }

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
          if (headBytes < CLASSIFY_HEAD_BYTES) {
            const slice = chunk.subarray(0, CLASSIFY_HEAD_BYTES - headBytes);
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
        context: { layerIndex, limitations, limits, stage, deadline, budget, createSurfaceStager, readerOptions },
      });
    }
  } finally {
    layerSurface.close();
    source.close();
  }
  return {
    paths,
    symlinks,
    appMembers,
    staged,
    limitations,
    members,
    expandedBytes,
    archiveSurfaceBytes,
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
  const extension = unexpandableFormat(name);
  if (extension !== undefined) {
    // Scanned as OPAQUE BYTES, which is not decoded inspection and is not reported as one.
    limitations.push({ kind: "unexpanded-archive-format", layer: layerIndex, extension, ...at });
    return;
  }
  /**
   * …and the same gap when the NAME says nothing. Reported under `format` rather than `extension`
   * because they are different evidence: `extension` means a name this audit recognises, `format`
   * means bytes it recognises. Both are closed vocabularies; neither is derived from the member.
   */
  const format = unsupportedMagicFormat(head);
  if (format !== undefined) {
    limitations.push({ kind: "unexpanded-archive-format", layer: layerIndex, format, ...at });
    return;
  }
  // An ordinary file — neither gzip, nor a tar candidate by its bytes, nor declared a tar by its name —
  // is already staged and has nothing to expand.
  if (!looksGzip(head) && !isTarCandidate(head) && !TAR_INTENT.test(name)) return;
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
  const { layerIndex, limitations, limits, stage, deadline, budget, createSurfaceStager, readerOptions } = context;
  const at = { depth };
  deadline?.assert("nested archive expansion");
  let nestedSurface;
  try {
    let data = bytes;
    const decodedFromGzip = looksGzip(data);
    if (decodedFromGzip) data = gunzipSync(data, { maxOutputLength: limits.maxMemberBytes });
    // A declared tar is parsed as one whatever its bytes say, so a malformed one refuses into a gap.
    if (!TAR_INTENT.test(name) && !isTarCandidate(data.subarray(0, CLASSIFY_HEAD_BYTES))) {
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
      classifyExpanded({ head: data.subarray(0, CLASSIFY_HEAD_BYTES), name: inflatedName, depth, read: (sink) => sink(data), context });
      return;
    }
    /**
     * A nested tar's own archive surface. For a tar DECODED FROM GZIP it is staged here: the only
     * copy the scanner otherwise saw was the compressed member, which no rule reads. An UNCOMPRESSED
     * nested tar needs nothing more — its every byte, headers and trailer included, was already staged
     * as the enclosing member's content, and staging it twice buys no coverage.
     */
    const nestedSource = bufferSource(data);
    nestedSurface = decodedFromGzip && createSurfaceStager ? createSurfaceStager({ source: nestedSource, depth }) : undefined;
    for (const nested of readTarMembers(nestedSource, {
      maxMembers: limits.maxMembersPerLayer,
      ...(readerOptions ?? tarReaderOptions(limits, deadline)),
      ...(nestedSurface ? { onSurface: (range) => nestedSurface.stage(range) } : {}),
      nonzeroTrailer: "surface",
      // The same gap one level down, whether or not the nested tar was compressed: its trailer bytes
      // were scanned (as surface, or as the enclosing member's content) but never decoded.
      onNonzeroTrailer: () => limitations.push({ kind: "archive-trailer-nonzero", layer: layerIndex, ...at }),
    })) {
      // The same sweep as the top level: an unsafe nested name is recorded, never silently passed over.
      if (!nested.path.safe) limitations.push({ kind: "unsafe-member-path", layer: layerIndex, ...at });
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
      const nestedName = `${name}#${nested.canonicalName ?? nested.name}`;
      const chunks = [];
      if (stage(nestedName, (write) => nested.content((chunk) => { chunks.push(Buffer.from(chunk)); write(chunk); }), depth, nested.size) === undefined) {
        limitations.push({ kind: exhaustionKind(budget), layer: layerIndex, ...at });
        break;
      }
      const nestedBytes = Buffer.concat(chunks);
      classifyExpanded({
        head: nestedBytes.subarray(0, CLASSIFY_HEAD_BYTES),
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
  } finally {
    nestedSurface?.close();
  }
}
