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

export class TarFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "TarFormatError";
  }
}

function trimNul(buffer) {
  const end = buffer.indexOf(0);
  return (end === -1 ? buffer : buffer.subarray(0, end)).toString("utf8");
}

/** Octal, or GNU base-256 for values that do not fit. An unparseable size is a corrupt archive. */
function numericField(buffer, label) {
  if (buffer.length && (buffer[0] & 0x80) !== 0) {
    let value = 0n;
    // The high bit is the base-256 marker, not part of the magnitude.
    let first = true;
    for (const byte of buffer) {
      value = (value << 8n) | BigInt(first ? byte & 0x7f : byte);
      first = false;
    }
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) throw new TarFormatError(`tar ${label} exceeds a safe integer`);
    return asNumber;
  }
  const text = trimNul(buffer).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError(`tar ${label} is not an octal field`);
  return Number.parseInt(text, 8);
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

/** PAX records are `<len> <key>=<value>\n`, with `<len>` counting its own digits. */
export function parsePaxRecords(text) {
  const records = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) throw new TarFormatError("PAX record has no length separator");
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > text.length) {
      throw new TarFormatError("PAX record length is out of range");
    }
    const body = text.slice(space + 1, offset + length).replace(/\n$/, "");
    const equals = body.indexOf("=");
    if (equals === -1) throw new TarFormatError("PAX record has no key separator");
    records[body.slice(0, equals)] = body.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * How a member NAME would behave if anyone extracted it. Classification, not sanitisation: this
 * reader writes nothing, so an unsafe name is reported rather than repaired.
 */
export function classifyMemberPath(name) {
  const raw = String(name ?? "");
  if (raw === "") return { safe: false, reason: "empty" };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\")) return { safe: false, reason: "absolute" };
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "..")) return { safe: false, reason: "traversal" };
  if (raw.includes("\0")) return { safe: false, reason: "nul-byte" };
  return { safe: true, reason: "relative" };
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

/**
 * Iterate members. `content(sink)` streams the member's bytes in bounded chunks and returns their
 * sha256 — the ONE way content leaves this module, so nothing can read a member without the caller
 * deciding where its bytes go.
 */
export function* readTarMembers(source, { maxMembers = 500_000, chunkBytes = 1024 * 1024 } = {}) {
  let offset = 0;
  let pax = {};
  let globalPax = {};
  let gnuName;
  let gnuLink;
  let emitted = 0;

  while (offset + BLOCK <= source.size) {
    const header = source.read(offset, BLOCK);
    if (header.length < BLOCK) throw new TarFormatError("tar archive ends inside a header block");
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    verifyChecksum(header);

    const typeflag = String.fromCharCode(header[156]);
    const size = numericField(header.subarray(124, 136), "size");
    const dataOffset = offset + BLOCK;
    /** Blocks occupied by `bytes` of member data. The stride to the next header. */
    const strideTo = (bytes) => dataOffset + Math.ceil(bytes / BLOCK) * BLOCK;

    // The extended headers below carry their OWN length in the ustar size field — a PAX `size`
    // record describes the member the header applies to, never the header itself.
    if (typeflag === "L" || typeflag === "K") {
      if (strideTo(size) > source.size) throw new TarFormatError("tar member data runs past the end of the archive");
      const value = trimNul(source.read(dataOffset, size));
      if (typeflag === "L") gnuName = value;
      else gnuLink = value;
      offset = strideTo(size);
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      if (strideTo(size) > source.size) throw new TarFormatError("tar member data runs past the end of the archive");
      const records = parsePaxRecords(source.read(dataOffset, size).toString("utf8"));
      if (typeflag === "g") globalPax = { ...globalPax, ...records };
      else pax = { ...pax, ...records };
      offset = strideTo(size);
      continue;
    }

    const ustarName = trimNul(header.subarray(0, 100));
    const prefix = trimNul(header.subarray(345, 500));
    const linkname = trimNul(header.subarray(157, 257));
    const merged = { ...globalPax, ...pax };
    const name = merged.path ?? gnuName ?? (prefix ? `${prefix}/${ustarName}` : ustarName);
    const link = merged.linkpath ?? gnuLink ?? linkname;
    /**
     * A PAX `size` record OVERRIDES the ustar size field — that is the whole point of it, and for a
     * member larger than the octal field can hold the ustar size is `0`.
     *
     * So it must drive the STRIDE to the next header, not just the content length. Taking
     * `min(size, paxSize)` (or the ustar size alone) would read zero bytes AND land the next header
     * read in the middle of this member's data, silently misparsing the rest of the archive into
     * plausible garbage — an inventory that looks complete and is not.
     */
    const dataSize = merged.size !== undefined ? Number.parseInt(merged.size, 10) : size;
    if (!Number.isSafeInteger(dataSize) || dataSize < 0) throw new TarFormatError("PAX size record is out of range");
    const nextOffset = strideTo(dataSize);
    if (nextOffset > source.size) throw new TarFormatError("tar member data runs past the end of the archive");

    if (++emitted > maxMembers) throw new TarFormatError(`tar archive exceeds the ${maxMembers}-member limit`);

    const type = MEMBER_TYPES[typeflag] ?? "unsupported";
    const contentSize = type === "file" ? dataSize : 0;
    yield Object.freeze({
      name,
      type,
      typeflag,
      size: contentSize,
      linkTarget: type === "symlink" || type === "hardlink" ? link : "",
      mode: numericField(header.subarray(100, 108), "mode"),
      path: classifyMemberPath(name),
      /**
       * Where this member's bytes start in the SOURCE. A second pass uses it to stream a large
       * member (an image layer blob) straight through a decompressor without ever holding it in
       * memory — the alternative, buffering a multi-gigabyte layer to hash it, is how a bounded
       * audit turns into an out-of-memory failure that looks like a product bug.
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
        while (read < contentSize) {
          const chunk = source.read(dataOffset + read, Math.min(chunkBytes, contentSize - read));
          if (chunk.length === 0) throw new TarFormatError("tar member data ended early");
          hash.update(chunk);
          sink?.(chunk);
          read += chunk.length;
        }
        return { sha256: hash.digest("hex"), bytes: read };
      },
    });

    pax = {};
    gnuName = undefined;
    gnuLink = undefined;
    offset = nextOffset;
  }
}
