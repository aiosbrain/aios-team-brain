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
  block.write(fields.name.slice(0, 100), 0, 100, "utf8");
  block.write(octal(fields.mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(fields.size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii"); // checksum placeholder: eight spaces
  block.write(fields.typeflag, 156, 1, "ascii");
  block.write(fields.linkTarget.slice(0, 100), 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  if (fields.prefix) block.write(fields.prefix.slice(0, 155), 345, 155, "utf8");
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
    if (member.paxLongName) {
      const records = paxRecord("path", member.name) + (linkTarget ? paxRecord("linkpath", linkTarget) : "");
      blocks.push(pseudoMember("PaxHeader/record", "x", Buffer.from(records, "utf8")));
    }

    // A GNU/PAX long name still needs a truncated ustar name in the real header; that is exactly the
    // case where a reader that ignores the extended header sees the WRONG path.
    const ustarName = member.gnuLongName || member.paxLongName ? member.name.slice(0, 100) : member.name;
    const needsPrefix = !member.gnuLongName && !member.paxLongName && ustarName.length > 100;
    const split = needsPrefix ? ustarName.lastIndexOf("/", 100) : -1;
    blocks.push(header({
      name: needsPrefix && split > 0 ? ustarName.slice(split + 1) : ustarName,
      prefix: needsPrefix && split > 0 ? ustarName.slice(0, split) : undefined,
      size: content.length,
      typeflag,
      linkTarget,
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
