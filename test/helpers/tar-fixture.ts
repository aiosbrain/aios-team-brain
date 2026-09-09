/**
 * A minimal tar WRITER, for AIO-997 audit fixtures only.
 *
 * The audit's reader is the thing under test, so its fixtures must not come from the same code: this
 * builds ustar/PAX/GNU headers by hand, including the hostile shapes (absolute paths, `..` traversal,
 * escaping symlinks, external hardlinks) that a real tar utility refuses to create. Nothing here runs
 * outside the unit tier, and every secret-shaped value a caller passes in is generated per run.
 */
import { randomBytes } from "node:crypto";

const BLOCK = 512;

export interface TarMemberSpec {
  name: string;
  content?: string | Buffer;
  type?: "file" | "directory" | "symlink" | "hardlink" | "fifo";
  linkTarget?: string;
  mode?: number;
  /** Force a GNU `L` long-name header instead of ustar name/prefix splitting. */
  gnuLongName?: boolean;
  /** Force a PAX `x` header carrying `path` (and `linkpath` when a link target is present). */
  paxLongName?: boolean;
  /** Corrupt the header checksum, to prove a corrupt archive fails rather than reads short. */
  corruptChecksum?: boolean;
  /**
   * Write the member's real length in a PAX `size` record and ZERO in the ustar size field — how a
   * member too large for the octal field is actually encoded. A reader that trusts the ustar field
   * reads no content AND loses its place in the archive.
   */
  paxSize?: boolean;
  /** An arbitrary typeflag, for the member types this reader must refuse rather than ignore. */
  rawTypeflag?: string;
}

const TYPEFLAG: Record<string, string> = {
  file: "0",
  hardlink: "1",
  symlink: "2",
  directory: "5",
  fifo: "6",
};

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** Bytes, not characters: every ustar field is a fixed-width byte range. */
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** Truncate to what the 100-byte ustar name field holds, without splitting a multi-byte character. */
function ustarTruncate(name: string): string {
  let out = name;
  while (bytes(out) > 100) out = out.slice(0, -1);
  return out;
}

export interface UstarSplit {
  name: string;
  prefix?: string;
}

/**
 * The ustar `prefix`/`name` split for a long member path — or a REFUSAL.
 *
 * THE BUG THIS REPLACES. The old fixture split at the last `/` before character 100 and let
 * `header()` silently `slice(0, 100)` whatever was left, so a deep path was written to the archive
 * under a TRUNCATED name. The reader then returned that truncated name — correctly, since it is what
 * the archive said — and the test that asserted the full path failed against a fixture bug rather
 * than a reader bug.
 *
 * ustar holds `prefix` (155 bytes) + `/` + `name` (100 bytes), so a name is only representable if
 * some `/` splits it that way. This picks the largest such prefix, as tar does, and REFUSES anything
 * unrepresentable: a fixture that cannot encode what the test claims must fail loudly, not quietly
 * encode something else.
 */
export function ustarSplit(name: string): UstarSplit {
  if (bytes(name) <= 100) return { name };
  const slashes = [...name].reduce<number[]>((at, char, index) => (char === "/" ? [...at, index] : at), []);
  for (const at of [...slashes].reverse()) {
    const prefix = name.slice(0, at);
    const basename = name.slice(at + 1);
    if (basename === "" || prefix === "") continue;
    if (bytes(prefix) <= 155 && bytes(basename) <= 100) return { name: basename, prefix };
  }
  throw new Error(
    `ustar cannot represent the ${bytes(name)}-byte member name (no '/' splits it into a <=155-byte ` +
    `prefix and a <=100-byte name); use gnuLongName or paxLongName for this fixture`,
  );
}

function header(fields: {
  name: string;
  size: number;
  typeflag: string;
  linkTarget: string;
  mode: number;
  prefix?: string;
  corruptChecksum?: boolean;
}): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  // Asserted, never truncated. A field that quietly loses bytes writes an archive that says something
  // different from what the caller asked for, and a fixture is only useful if it encodes the case.
  for (const [field, value, width] of [["name", fields.name, 100], ["prefix", fields.prefix ?? "", 155], ["linkname", fields.linkTarget, 100]] as const) {
    if (bytes(value) > width) throw new Error(`ustar ${field} field holds ${width} bytes; ${bytes(value)} were given`);
  }
  block.write(fields.name, 0, 100, "utf8");
  block.write(octal(fields.mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(fields.size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii"); // checksum placeholder: eight spaces
  block.write(fields.typeflag, 156, 1, "ascii");
  block.write(fields.linkTarget, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  if (fields.prefix) block.write(fields.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  if (fields.corruptChecksum) sum += 1;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function padded(content: Buffer): Buffer {
  const remainder = content.length % BLOCK;
  return remainder === 0 ? content : Buffer.concat([content, Buffer.alloc(BLOCK - remainder, 0)]);
}

function pseudoMember(name: string, typeflag: string, body: Buffer): Buffer {
  return Buffer.concat([
    header({ name, size: body.length, typeflag, linkTarget: "", mode: 0o644 }),
    padded(body),
  ]);
}

function paxRecord(key: string, value: string): string {
  // The length field counts its own digits, so it has to be solved rather than measured once.
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${length}${body}`;
}

export function buildTar(members: TarMemberSpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const type = member.type ?? "file";
    const typeflag = TYPEFLAG[type];
    const content = type === "file"
      ? Buffer.isBuffer(member.content) ? member.content : Buffer.from(member.content ?? "", "utf8")
      : Buffer.alloc(0);
    const linkTarget = member.linkTarget ?? "";

    if (member.gnuLongName) blocks.push(pseudoMember("././@LongLink", "L", Buffer.from(`${member.name}\0`, "utf8")));
    if (member.paxLongName || member.paxSize) {
      const records = (member.paxLongName ? paxRecord("path", member.name) : "")
        + (member.paxLongName && linkTarget ? paxRecord("linkpath", linkTarget) : "")
        + (member.paxSize ? paxRecord("size", String(content.length)) : "");
      blocks.push(pseudoMember("PaxHeader/record", "x", Buffer.from(records, "utf8")));
    }

    // A GNU/PAX long name still needs a truncated ustar name in the real header; that is exactly the
    // case where a reader that ignores the extended header sees the WRONG path. Without one, the name
    // must genuinely FIT the ustar name/prefix fields or `ustarSplit` refuses the fixture.
    const extended = Boolean(member.gnuLongName || member.paxLongName);
    const split = extended ? { name: ustarTruncate(member.name), prefix: undefined } : ustarSplit(member.name);
    blocks.push(header({
      name: split.name,
      prefix: split.prefix,
      // ZERO when the PAX record carries the real size — the encoding a reader must honour, and the
      // one where trusting the ustar field loses the reader's place in the archive.
      size: member.paxSize ? 0 : content.length,
      typeflag: member.rawTypeflag ?? typeflag,
      linkTarget: extended ? ustarTruncate(linkTarget) : linkTarget,
      mode: member.mode ?? (type === "directory" ? 0o755 : 0o644),
      corruptChecksum: member.corruptChecksum,
    }));
    if (content.length) blocks.push(padded(content));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(blocks);
}

/**
 * A generated credential-shaped value. NEVER a real or copied credential: every fixture secret in
 * this suite is minted per run, so a test file cannot become a place a real key hides.
 */
export function syntheticSecret(prefix = "ghp_"): string {
  return `${prefix}${randomBytes(24).toString("base64url").slice(0, 32)}`;
}
