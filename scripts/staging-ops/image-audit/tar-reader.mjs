/**
 * AIO-997 audit — a tar reader that PARSES members and never extracts them.
 *
 * THE SAFETY ARGUMENT, stated once. Every hostile-archive class (absolute member path, `..`
 * traversal, a symlink out of the tree followed by a member written through it, a hardlink to a host
 * file) is an EXTRACTION vulnerability: it needs the reader to turn an archive-supplied string into a
 * filesystem path. This reader never does. It yields member metadata plus a bounded content reader,
 * and the caller writes content — when it writes at all — under a name THIS PROCESS chose inside
 * fresh scratch. Unsafe names are therefore not a hazard to defend against with a sanitiser that
 * could be wrong; they are DATA, classified and reported.
 *
 * Links are metadata only. A symlink/hardlink member carries a target string that is recorded and
 * compared as a string, never resolved and never opened. "Compare symlinks as links without
 * following them" (PUB-02) is structural here for the same reason.
 *
 * Formats: POSIX ustar, PAX extended headers (`x`/`g`), and GNU long name/link (`L`/`K`) — the
 * long-name metadata a real image export uses. Anything else is refused by name rather than skipped.
 */
import { createHash } from "node:crypto";

const BLOCK = 512;

/** A random-access byte source. Deliberately tiny: a Buffer in tests, a file descriptor in the job. */
export function bufferSource(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return {
    size: bytes.length,
    read(position, length) {
      if (position < 0 || length < 0) throw new Error("tar source read out of range");
      return bytes.subarray(position, Math.min(bytes.length, position + length));
    },
  };
}

/**
 * STRUCTURAL refusal, as a FIXED code. A malformed archive is not a smaller archive: reading it as one
 * is how a short buffer or a truncated layer used to come back as a verified, fully covered, empty
 * inventory. The message is this module's own text and never quotes archive bytes.
 */
export class TarFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "TarFormatError";
    this.code = "AUDIT_TAR_STRUCTURE_INVALID";
  }
}

/**
 * A RESOURCE bound, as a different fixed code. "The archive is malformed" and "the archive is shaped to
 * exhaust the audit" have different remedies, and the sanitized record carries only this code.
 */
export class TarLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "TarLimitError";
    this.code = "AUDIT_TAR_LIMIT_EXCEEDED";
  }
}

/**
 * The reviewed ceilings for the metadata a tar carries ABOUT its members (AC-AUDIT-04).
 *
 * THE DEFECT THESE EXIST FOR. A GNU `L`/`K` or PAX `x`/`g` body used to be read with ONE
 * `source.read(offset, size)` BEFORE any bound was consulted, and those headers never counted towards
 * `maxMembers`. A 300 MiB long-name declaration in a small compressed layer requested a 314,572,800-byte
 * allocation, and an archive of nothing but metadata headers walked forever without touching the member
 * count or the clock. Each ceiling below is checked BEFORE the read it bounds.
 *
 *   `maxMetadataRecordBytes`  — one metadata body. Real long names and PAX records are tiny.
 *   `maxPendingMetadataBytes` — every metadata body accumulated since the last member, so a flood of
 *                               small `x` records ahead of one member is bounded as a total.
 *   `maxPhysicalHeaders`      — EVERY header block the reader processes, metadata included.
 */
export const TAR_READER_LIMITS = Object.freeze({
  maxMetadataRecordBytes: 1024 * 1024,
  maxPendingMetadataBytes: 4 * 1024 * 1024,
  maxPhysicalHeaders: 1_500_000,
});

/** How many physical headers, and how many content bytes, pass between consultations of the clock. */
const DEADLINE_EVERY_HEADERS = 512;
const DEADLINE_EVERY_BYTES = 64 * 1024 * 1024;

function trimNul(buffer) {
  const end = buffer.indexOf(0);
  return (end === -1 ? buffer : buffer.subarray(0, end)).toString("utf8");
}

const isZeroBlock = (buffer) => buffer.every((byte) => byte === 0);

/**
 * Octal, or GNU base-256 for values that do not fit. An unparseable, negative or unsafe value is a
 * corrupt archive — never a zero, which is the value that would quietly shorten a member.
 */
function numericField(buffer, label) {
  if (buffer.length && (buffer[0] & 0x80) !== 0) {
    // 0x80 is the positive base-256 marker. 0xff (and anything else with the high bit set) is GNU's
    // NEGATIVE encoding or garbage, and a negative size or mode has no meaning here.
    if (buffer[0] !== 0x80) throw new TarFormatError(`tar ${label} is a negative or malformed base-256 field`);
    let value = 0n;
    for (const byte of buffer.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TarFormatError(`tar ${label} exceeds a safe integer`);
    return Number(value);
  }
  const text = trimNul(buffer).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError(`tar ${label} is not an octal field`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new TarFormatError(`tar ${label} exceeds a safe integer`);
  return value;
}

/**
 * The ustar header checksum, verified. A corrupt archive must FAIL the audit rather than yield a
 * plausible member list — silently reduced coverage is the outcome this whole build exists to avoid.
 */
function verifyChecksum(header) {
  const declared = trimNul(header.subarray(148, 156)).trim();
  if (declared === "") throw new TarFormatError("tar header carries no checksum");
  if (!/^[0-7]+$/.test(declared)) throw new TarFormatError("tar header checksum is not an octal field");
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  const expected = Number.parseInt(declared, 8);
  if (expected !== unsigned && expected !== signed) {
    throw new TarFormatError(`tar header checksum ${expected} does not match the header bytes`);
  }
}

/**
 * Is `head`'s FIRST 512-byte block a header this reader would accept? (B1)
 *
 * The same checksum rule and size-field rule `readTarMembers` applies, over ONE bounded block — so the
 * inspector's tar recogniser and this reader share one definition of "a tar header", magic or not. A
 * magic-less V7 tar is read by the parser, and a recogniser that only knew the ustar magic declined it,
 * leaving a gzipped member inside it unexpanded under complete coverage. An all-zero block is not a
 * header (the canonical empty archive is recognised separately). The full parser stays the authority:
 * this only decides whether to TRY it.
 */
export function isChecksumValidTarHeader(head) {
  if (!Buffer.isBuffer(head) || head.length < BLOCK) return false;
  const block = head.subarray(0, BLOCK);
  if (isZeroBlock(block)) return false;
  try {
    verifyChecksum(block);
    numericField(block.subarray(124, 136), "size");
    return true;
  } catch {
    return false;
  }
}

/** The only PAX keys whose VALUES this reader interprets. Every other value is opaque bytes. */
const INTERPRETED_PAX_KEYS = Object.freeze(["path", "linkpath", "size"]);
/**
 * `ignoreBOM: true` KEEPS a leading U+FEFF in the decoded value. The default strips it, which would make
 * `\uFEFFapp/x` and `app/x` the same name — a lossy decode of an interpreted value.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * PAX records are `<len> <key>=<value>\n`, where `<len>` is a DECIMAL BYTE COUNT of the whole record
 * including its own digits (AC-AUDIT-05).
 *
 * BYTES, NOT CHARACTERS. This used to decode the body to a JavaScript string and walk string offsets,
 * so a correctly byte-counted `path=app/é.txt` was refused as out of range and any record after a
 * multi-byte character was misframed. Framing now happens on the raw bytes; only the values of
 * `path`, `linkpath` and `size` are ever decoded, strictly (no lossy replacement character). Every
 * other value — a binary xattr included — stays opaque: it is not rejected for being invalid UTF-8,
 * and it is never interpreted, because its bytes reach the scanner through the archive surface.
 *
 * Returns ONLY the interpreted keys that were present.
 */
export function parsePaxRecords(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1 || space === offset || space - offset > 16) throw new TarFormatError("PAX record has no valid length field");
    const digits = bytes.subarray(offset, space).toString("latin1");
    if (!/^[1-9][0-9]*$/.test(digits)) throw new TarFormatError("PAX record length is not a decimal byte count");
    const length = Number(digits);
    const end = offset + length;
    // The smallest well-formed record after the length is ` k=\n`: a space, a one-byte key, `=`, `\n`.
    if (!Number.isSafeInteger(end) || length < digits.length + 4 || end > bytes.length) {
      throw new TarFormatError("PAX record length is out of range");
    }
    if (bytes[end - 1] !== 0x0a) throw new TarFormatError("PAX record does not end at its declared newline");
    const body = bytes.subarray(space + 1, end - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) throw new TarFormatError("PAX record has no key separator");
    const key = body.subarray(0, equals).toString("latin1");
    /**
     * GNU SPARSE metadata renames the member (`GNU.sparse.name` IS the name Go's `archive/tar` extracts)
     * and re-describes its data layout. This reader implements neither, so a record carrying any
     * `GNU.sparse.*` key — local or global — is refused rather than read under the wrong name. (B2)
     */
    if (key.startsWith("GNU.sparse.")) throw new TarFormatError("PAX GNU.sparse metadata is not supported");
    if (INTERPRETED_PAX_KEYS.includes(key)) {
      const raw = body.subarray(equals + 1);
      let value;
      try {
        value = STRICT_UTF8.decode(raw);
      } catch {
        throw new TarFormatError("PAX path, linkpath or size value is not valid UTF-8");
      }
      // An EMPTY path or linkpath is not "no override": `?? ustarName` would take it, name the member
      // `""`, and hide a real `/app` file from the inventory, while POSIX readers ignore the empty
      // value and extract the ustar name. Refused rather than guessed at either way.
      if ((key === "path" || key === "linkpath") && value === "") {
        throw new TarFormatError("PAX path or linkpath value is empty");
      }
      // A NUL is not part of any name. `"\0"` is not empty, so it slipped past the check above and named
      // a member whose real ustar name an extractor would write — hiding it from the inventory.
      if ((key === "path" || key === "linkpath") && value.includes("\0")) {
        throw new TarFormatError("PAX path or linkpath value contains a NUL byte");
      }
      if (key === "size") {
        if (!/^[0-9]{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new TarFormatError("PAX size record is not a safe non-negative decimal");
        }
        records.size = Number(value);
      } else {
        records[key] = value;
      }
    }
    offset = end;
  }
  return records;
}

/**
 * THE ONE CANONICAL MEMBER PATH (B2), computed from the name AFTER ustar/PAX/GNU resolution, and the
 * only form the inventory, the whiteout/merge computation, the build-output categories and the public
 * path lookup see.
 *
 * WHY. An extractor cleans a name before writing it: `././app/x`, `.//app/x` and `app/./x` all land at
 * `app/x`. Comparing the raw spelling put such a member outside the `/app` prefix and silently out of
 * the inventory while the runtime wrote it inside `/app`. So repeated `/` and `.` segments collapse;
 * Unicode and case are preserved exactly; and anything whose meaning depends on the host is REFUSED
 * rather than guessed at: `..`, an absolute or drive-letter path, a backslash, an empty or NUL-bearing
 * name, and a trailing `/` on anything but a directory. `.`/`./` is allowed only as the root-directory
 * sentinel. The raw bytes still reach the scanner unchanged; a link TARGET is never canonicalised or
 * followed.
 *
 * `{ ok: true, path }` or `{ ok: false, reason }` from a closed vocabulary.
 */
export function canonicalMemberPath(name, type) {
  const raw = String(name ?? "");
  if (raw === "") return { ok: false, reason: "empty" };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\")) return { ok: false, reason: "absolute" };
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "..")) return { ok: false, reason: "traversal" };
  if (raw.includes("\0")) return { ok: false, reason: "nul-byte" };
  if (raw.includes("\\")) return { ok: false, reason: "backslash" };
  const kept = segments.filter((segment) => segment !== "" && segment !== ".");
  const trailingSlash = raw.endsWith("/");
  if (kept.length === 0) return type === "directory" ? { ok: true, path: "." } : { ok: false, reason: "empty" };
  if (trailingSlash && type !== undefined && type !== "directory") return { ok: false, reason: "trailing-slash" };
  return { ok: true, path: `${kept.join("/")}${trailingSlash ? "/" : ""}` };
}

/**
 * How a member NAME would behave if anyone extracted it. Classification, not sanitisation: this
 * reader writes nothing, so an unsafe name is reported rather than repaired. Delegates to the one
 * canonical-path rule so the two cannot disagree.
 */
export function classifyMemberPath(name, type) {
  const canonical = canonicalMemberPath(name, type);
  return canonical.ok ? { safe: true, reason: "relative" } : { safe: false, reason: canonical.reason };
}

/** A link TARGET that leaves the archive root. Recorded; never resolved, never opened. */
export function classifyLinkTarget(target) {
  const raw = String(target ?? "");
  if (raw === "") return { escapes: false, reason: "empty" };
  if (raw.startsWith("/")) return { escapes: true, reason: "absolute" };
  let depth = 0;
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return { escapes: true, reason: "traversal" };
    } else depth += 1;
  }
  return { escapes: false, reason: "contained" };
}

export const MEMBER_TYPES = Object.freeze({
  "0": "file",
  "\0": "file",
  "1": "hardlink",
  "2": "symlink",
  "3": "character-device",
  "4": "block-device",
  "5": "directory",
  "6": "fifo",
  "7": "file",
});

/** Typeflags that describe a member with NO body. A non-zero effective size on one hides bytes. */
const HEADER_ONLY_TYPES = new Set(["hardlink", "symlink", "character-device", "block-device", "directory", "fifo"]);

/**
 * Iterate members, validating the archive's STRUCTURE independently of what is later scanned.
 *
 * `content(sink)` streams a regular member's bytes in bounded chunks and returns their sha256 — the ONE
 * way member content leaves this module.
 *
 * THE ACCEPTED SHAPE (AC-AUDIT-03), stated once:
 *   - input of zero bytes is not an archive, and a canonical empty archive is exactly two zero blocks;
 *   - every header is a complete 512-byte block with a valid checksum — a partial header anywhere,
 *     including a 1–511-byte "archive", is refused rather than read as zero members;
 *   - every declared body and its padding lies inside the input, with safe-integer arithmetic;
 *   - the archive ENDS with two complete zero blocks. EOF without them, or a single zero block, is
 *     refused. Further zero padding is accepted; NON-ZERO bytes after the marker are either reported
 *     to `onSurface` as opaque bytes to scan AND reported once to `onNonzeroTrailer`, so the caller
 *     records the gap (`nonzeroTrailer: "surface"`, which requires that callback), or refused
 *     (`"refuse"`, the default) — never silently discarded, which is what the old `break` did;
 *   - a header-only typeflag (`1`–`6`) with a non-zero effective size is refused: striding past a body
 *     nobody reads and still reporting a complete inventory is how a member hides inside another.
 *
 * THE ARCHIVE SURFACE (AC-AUDIT-02). Everything that is not a regular member's content — every header
 * block (ordinary, PAX `x`/`g`, GNU `L`/`K`), metadata bodies, member padding, the body of an
 * unsupported typeflag, the end-of-archive blocks and trailing bytes — is reported, IN ARCHIVE ORDER,
 * as `onSurface({ offset, length, kind })`. Each call is one contiguous range the caller must keep
 * whole; adjacent ranges may be joined. A regular member's content is the complement, reached through
 * `content()`. Together they account for every byte of the input.
 *
 * BOUNDS (AC-AUDIT-04). Metadata bodies are checked against `maxMetadataRecordBytes` BEFORE they are
 * read, accumulated metadata since the last member against `maxPendingMetadataBytes`, and every
 * physical header against `maxPhysicalHeaders`. The clock (`deadline.assert`) is consulted on entry,
 * every `deadlineEveryHeaders` headers — metadata-only archives included — and every
 * `deadlineEveryBytes` of content streamed.
 */
export function* readTarMembers(source, {
  maxMembers = 500_000,
  chunkBytes = 1024 * 1024,
  maxMetadataRecordBytes = TAR_READER_LIMITS.maxMetadataRecordBytes,
  maxPendingMetadataBytes = TAR_READER_LIMITS.maxPendingMetadataBytes,
  maxPhysicalHeaders = TAR_READER_LIMITS.maxPhysicalHeaders,
  deadline,
  deadlineEveryHeaders = DEADLINE_EVERY_HEADERS,
  deadlineEveryBytes = DEADLINE_EVERY_BYTES,
  onSurface,
  nonzeroTrailer = "refuse",
  onNonzeroTrailer,
} = {}) {
  /**
   * FAIL-CLOSED BY DEFAULT. A non-zero trailer is refused unless the caller asked for `"surface"` AND
   * supplied the callback that records it — so a caller that forgets either can only get a refusal,
   * never a trailer that was quietly scanned as opaque bytes and reported as covered.
   */
  if (nonzeroTrailer !== "refuse" && nonzeroTrailer !== "surface") throw new TypeError("nonzeroTrailer must be \"refuse\" or \"surface\"");
  if (nonzeroTrailer === "surface" && typeof onNonzeroTrailer !== "function") {
    throw new TypeError("nonzeroTrailer \"surface\" requires an onNonzeroTrailer callback that records the gap");
  }
  if (!Number.isSafeInteger(source.size) || source.size < 0) throw new TarFormatError("tar source size is not a safe integer");
  if (source.size === 0) throw new TarFormatError("a zero-length input is not a tar archive; an empty archive is two zero blocks");
  deadline?.assert("tar headers");

  const surface = (offset, length, kind) => {
    if (length > 0) onSurface?.(Object.freeze({ offset, length, kind }));
  };
  const readExactly = (position, length) => {
    const bytes = source.read(position, length);
    if (bytes.length !== length) throw new TarFormatError("tar archive ended inside a block it declared");
    return bytes;
  };

  let offset = 0;
  let pax = {};
  // Set by ANY local `x` header, even one carrying only opaque keys: a second one before the member is
  // ambiguous (Go's reader keeps only the last; a merge keeps both), so it is refused. (B2)
  let localPaxPending = false;
  let gnuName;
  let gnuLink;
  let emitted = 0;
  let headers = 0;
  let pendingMetadata = 0;

  while (true) {
    const remaining = source.size - offset;
    if (remaining === 0) throw new TarFormatError("tar archive ends without its end-of-archive blocks");
    if (remaining < BLOCK) throw new TarFormatError("tar archive ends inside a header block");
    const header = readExactly(offset, BLOCK);

    if (isZeroBlock(header)) {
      // The end-of-archive marker is TWO complete zero blocks. One, or one followed by anything
      // non-zero, is a truncated or spliced archive and is refused rather than read as complete.
      if (remaining < 2 * BLOCK) throw new TarFormatError("tar archive ends inside its end-of-archive marker");
      if (!isZeroBlock(readExactly(offset + BLOCK, BLOCK))) {
        throw new TarFormatError("tar end-of-archive marker is a single zero block");
      }
      /**
       * Anything but zeros after the marker. Checked in bounded chunks, under the clock, in EVERY mode:
       * a non-zero trailer is bytes no member interpretation decoded — a gzip stream, a ZIP or a whole
       * second tar can sit there (`tar -A` produces exactly that) — so staging it as opaque bytes is
       * not decoded inspection. `"refuse"` throws; otherwise `onNonzeroTrailer` is told once, so the
       * caller records a gap that blocks while still scanning the bytes it has.
       */
      let at = offset + 2 * BLOCK;
      let sinceCheck = 0;
      while (at < source.size) {
        const chunk = readExactly(at, Math.min(chunkBytes, source.size - at));
        if (!isZeroBlock(chunk)) {
          if (nonzeroTrailer === "refuse") throw new TarFormatError("tar archive carries non-zero bytes after its end-of-archive marker");
          onNonzeroTrailer?.();
          break;
        }
        at += chunk.length;
        sinceCheck += chunk.length;
        if (deadline && sinceCheck >= deadlineEveryBytes) {
          sinceCheck = 0;
          deadline.assert("tar trailer");
        }
      }
      // The marker and everything after it, as ONE contiguous range: trailing bytes are distributed
      // with the archive, so they are scanned as opaque bytes rather than dropped.
      surface(offset, source.size - offset, "terminator");
      return;
    }

    headers += 1;
    if (headers > maxPhysicalHeaders) throw new TarLimitError(`tar archive exceeds the ${maxPhysicalHeaders}-header limit`);
    if (deadline && headers % deadlineEveryHeaders === 0) deadline.assert("tar headers");
    verifyChecksum(header);

    const typeflag = String.fromCharCode(header[156]);
    const size = numericField(header.subarray(124, 136), "size");
    const dataOffset = offset + BLOCK;
    /** The stride to the next header, with the arithmetic proven safe rather than assumed. */
    const strideTo = (bytes) => {
      const end = dataOffset + Math.ceil(bytes / BLOCK) * BLOCK;
      if (!Number.isSafeInteger(end)) throw new TarFormatError("tar member stride exceeds a safe integer");
      if (end > source.size) throw new TarFormatError("tar member data runs past the end of the archive");
      return end;
    };

    // The extended headers below carry their OWN length in the ustar size field — a PAX `size`
    // record describes the member the header applies to, never the header itself.
    if (typeflag === "L" || typeflag === "K" || typeflag === "x" || typeflag === "g") {
      // BEFORE the read: a declared body past the ceiling is refused without allocating it.
      if (size > maxMetadataRecordBytes) {
        throw new TarLimitError(`a tar metadata record declares more than the ${maxMetadataRecordBytes}-byte ceiling`);
      }
      pendingMetadata += size;
      if (pendingMetadata > maxPendingMetadataBytes) {
        throw new TarLimitError(`tar metadata ahead of one member exceeds the ${maxPendingMetadataBytes}-byte ceiling`);
      }
      const end = strideTo(size);
      const body = readExactly(dataOffset, size);
      if (typeflag === "L" || typeflag === "K") {
        // The same `""`-is-not-nullish hazard as an empty PAX path: refused, not taken as the name.
        const value = trimNul(body);
        if (value === "") throw new TarFormatError("GNU long name or long link is empty");
        if ((typeflag === "L" ? gnuName : gnuLink) !== undefined) {
          throw new TarFormatError("a repeated GNU long name or long link precedes one member");
        }
        if (typeflag === "L") gnuName = value;
        else gnuLink = value;
      }
      else {
        const records = parsePaxRecords(body);
        if (typeflag === "g" && (localPaxPending || gnuName !== undefined || gnuLink !== undefined)) {
          // Go returns a `g` header as an entry of its own and RESETS pending local metadata; a reader
          // that carries it across would name the next member differently. Refused, not guessed. (B2)
          throw new TarFormatError("a global PAX header arrives while member metadata is pending");
        }
        if (typeflag === "g") {
          // A GLOBAL override would redefine the name, target or size of EVERY later member; this
          // reader refuses to assume that filesystem semantics rather than guess at them. Global
          // records carrying only opaque metadata are accepted — and scanned, as surface.
          if (INTERPRETED_PAX_KEYS.some((key) => records[key] !== undefined)) {
            throw new TarFormatError("a global PAX header overrides path, linkpath or size");
          }
        } else {
          if (localPaxPending) throw new TarFormatError("a repeated local PAX header precedes one member");
          localPaxPending = true;
          pax = records;
        }
      }
      surface(offset, end - offset, "metadata");
      offset = end;
      continue;
    }

    // A GNU long name AND a PAX path (or long link AND PAX linkpath) for one member disagree about
    // precedence across readers — Go lets the GNU record win, this reader used to let PAX win — so the
    // member is refused whichever order they arrived in. (B2)
    if ((gnuName !== undefined && pax.path !== undefined) || (gnuLink !== undefined && pax.linkpath !== undefined)) {
      throw new TarFormatError("a GNU long name or link and a PAX path or linkpath both describe one member");
    }
    const ustarName = trimNul(header.subarray(0, 100));
    const prefix = trimNul(header.subarray(345, 500));
    const linkname = trimNul(header.subarray(157, 257));
    const name = pax.path ?? gnuName ?? (prefix ? `${prefix}/${ustarName}` : ustarName);
    const link = pax.linkpath ?? gnuLink ?? linkname;
    /**
     * A PAX `size` record OVERRIDES the ustar size field — that is the whole point of it, and for a
     * member larger than the octal field can hold the ustar size is `0`. So it drives the STRIDE to
     * the next header, not just the content length; anything else lands the next header read in the
     * middle of this member's data and misparses the rest of the archive into plausible garbage.
     */
    const dataSize = pax.size !== undefined ? pax.size : size;
    const type = MEMBER_TYPES[typeflag] ?? "unsupported";
    if (HEADER_ONLY_TYPES.has(type) && dataSize > 0) {
      throw new TarFormatError("a header-only tar member declares a non-zero body");
    }
    const nextOffset = strideTo(dataSize);

    if (++emitted > maxMembers) throw new TarLimitError(`tar archive exceeds the ${maxMembers}-member limit`);

    const contentSize = type === "file" ? dataSize : 0;
    const canonical = canonicalMemberPath(name, type);
    if (type === "unsupported") {
      // A body this reader does not interpret is still distributed: header, body and padding are one
      // opaque surface range. The caller ALSO records the unsupported type as a limitation.
      surface(offset, nextOffset - offset, "unsupported-member");
    } else {
      surface(offset, BLOCK, "header");
    }

    yield Object.freeze({
      name,
      type,
      typeflag,
      size: contentSize,
      linkTarget: type === "symlink" || type === "hardlink" ? link : "",
      mode: numericField(header.subarray(100, 108), "mode"),
      path: canonical.ok ? { safe: true, reason: "relative" } : { safe: false, reason: canonical.reason },
      /** The canonical relative path every consumer compares, or `undefined` when the name is unsafe. */
      canonicalName: canonical.ok ? canonical.path : undefined,
      /**
       * Where this member's bytes start in the SOURCE. A second pass uses it to stream a large member
       * (an image layer blob) straight through a decompressor without ever holding it in memory.
       */
      dataOffset,
      /**
       * Stream this member's bytes to `sink` and return their sha256. The sink is the caller's —
       * usually a scratch file under a name the AUDIT chose, never `member.name`.
       */
      content(sink) {
        if (type !== "file") throw new Error(`member ${type} has no content to read`);
        const hash = createHash("sha256");
        let read = 0;
        let sinceCheck = 0;
        while (read < contentSize) {
          const chunk = source.read(dataOffset + read, Math.min(chunkBytes, contentSize - read));
          if (chunk.length === 0) throw new TarFormatError("tar member data ended early");
          hash.update(chunk);
          sink?.(chunk);
          read += chunk.length;
          sinceCheck += chunk.length;
          if (deadline && sinceCheck >= deadlineEveryBytes) {
            sinceCheck = 0;
            deadline.assert("tar member content");
          }
        }
        return { sha256: hash.digest("hex"), bytes: read };
      },
    });

    // The padding after a regular member's content, reported AFTER the caller has handled the member,
    // so ranges reach `onSurface` in archive order and the padding joins the next header's range.
    if (type === "file") surface(dataOffset + contentSize, nextOffset - dataOffset - contentSize, "padding");

    pax = {};
    localPaxPending = false;
    gnuName = undefined;
    gnuLink = undefined;
    pendingMetadata = 0;
    offset = nextOffset;
  }
}
