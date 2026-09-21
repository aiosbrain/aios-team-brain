import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TAR_READER_LIMITS,
  TarFormatError,
  TarLimitError,
  bufferSource,
  parsePaxRecords,
  readTarMembers,
} from "../scripts/staging-ops/image-audit/tar-reader.mjs";
import { buildTar, syntheticSecret } from "./helpers/tar-fixture";

/**
 * AC-AUDIT-03/04/05 at READER level: archive STRUCTURE is validated independently of coverage,
 * metadata is bounded before it is read, and PAX is framed by bytes.
 *
 * THE FIXTURES HERE DO NOT COME FROM THE READER, and the PAX records do not come from its length
 * logic: `header()` and `paxRecord()` below are written from the ustar/PAX layout directly, so a
 * mistake shared by writer and reader cannot make a test pass.
 */

const BLOCK = 512;

interface RawHeader {
  name?: string | Buffer;
  size?: number;
  /** Raw bytes for the 12-byte size field, overriding `size`. For malformed/overflowing cases. */
  sizeField?: Buffer;
  typeflag?: string;
  linkname?: string | Buffer;
}

/** One ustar header block, checksummed. Independent of `tar-fixture.ts`. */
function header({ name = "app/f", size = 0, sizeField, typeflag = "0", linkname = "" }: RawHeader): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  (Buffer.isBuffer(name) ? name : Buffer.from(name, "utf8")).copy(block, 0, 0, 100);
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  if (sizeField) sizeField.copy(block, 124, 0, 12);
  else block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(typeflag, 156, 1, "latin1");
  (Buffer.isBuffer(linkname) ? linkname : Buffer.from(linkname, "utf8")).copy(block, 157, 0, 100);
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

const pad = (body: Buffer) => Buffer.concat([body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK, 0)]);
const END = Buffer.alloc(2 * BLOCK, 0);

/** A member: header + padded body. */
const member = (spec: RawHeader, body: Buffer = Buffer.alloc(0)) =>
  Buffer.concat([header({ ...spec, size: spec.size ?? body.length }), pad(body)]);

/**
 * A PAX record, byte-counted from scratch: `<len> <key>=<value>\n` where len is the total BYTES. The
 * value may be arbitrary bytes. Solved by trying each candidate width rather than by any shared helper.
 */
function paxRecord(key: string, value: Buffer | string): Buffer {
  const tail = Buffer.concat([Buffer.from(` ${key}=`, "utf8"), Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"), Buffer.from("\n")]);
  for (let digits = 1; digits < 12; digits += 1) {
    const total = digits + tail.length;
    if (String(total).length === digits) return Buffer.concat([Buffer.from(String(total), "ascii"), tail]);
  }
  throw new Error("unreachable");
}

const paxMember = (typeflag: "x" | "g", records: Buffer) => member({ name: "PaxHeader/r", typeflag }, records);

const read = (tar: Buffer, options: Record<string, unknown> = {}) => [...readTarMembers(bufferSource(tar), options)];

/** Every surface range the reader reports, in order. */
function surfaceOf(tar: Buffer, options: Record<string, unknown> = {}) {
  const ranges: { offset: number; length: number; kind: string }[] = [];
  const members = [...readTarMembers(bufferSource(tar), { ...options, onSurface: (range: { offset: number; length: number; kind: string }) => ranges.push(range) })];
  return { ranges, members };
}

// ---------------------------------------------------------------------------
// AC-AUDIT-03 — structure
// ---------------------------------------------------------------------------

describe("tar structure is validated independently of coverage (AC-AUDIT-03)", () => {
  it("refuses EVERY initial length from 1 to 511 bytes — a short buffer is not an empty archive", () => {
    for (let length = 1; length < BLOCK; length += 1) {
      const bytes = Buffer.alloc(length, length % 2 === 0 ? 0 : 0x41);
      expect(() => read(bytes), `length ${length}`).toThrow(TarFormatError);
    }
  });

  it("refuses zero-length input, and accepts the canonical 1,024-byte empty archive", () => {
    expect(() => read(Buffer.alloc(0))).toThrow(TarFormatError);
    const { members, ranges } = surfaceOf(END);
    expect(members).toEqual([]);
    // Even the empty archive's marker is surface: nothing about the input goes unaccounted.
    expect(ranges).toEqual([{ offset: 0, length: 1024, kind: "terminator" }]);
  });

  it("refuses a valid member followed by a PARTIAL header", () => {
    const tar = Buffer.concat([member({ name: "app/a" }, Buffer.from("x")), Buffer.alloc(100, 0x41)]);
    expect(() => read(tar)).toThrow(/ends inside a header block/);
  });

  it("refuses a member with no end-of-archive marker at all", () => {
    expect(() => read(member({ name: "app/a" }, Buffer.from("x")))).toThrow(/without its end-of-archive/);
  });

  it("refuses a single zero end block, and a zero block followed by non-zero bytes", () => {
    const body = member({ name: "app/a" }, Buffer.from("x"));
    expect(() => read(Buffer.concat([body, Buffer.alloc(BLOCK, 0)]))).toThrow(/end-of-archive marker/);
    expect(() => read(Buffer.concat([body, Buffer.alloc(BLOCK, 0), header({ name: "app/b" }), END]))).toThrow(/single zero block/);
  });

  it("refuses a body or its padding truncated before EOF", () => {
    const full = Buffer.concat([member({ name: "app/a" }, Buffer.alloc(600, 0x61)), END]);
    // Cut inside the body, then inside the padding block that follows it.
    expect(() => read(full.subarray(0, BLOCK + 300))).toThrow(TarFormatError);
    expect(() => read(full.subarray(0, BLOCK + 700))).toThrow(TarFormatError);
  });

  it("refuses malformed, negative and overflowing size fields", () => {
    const at = (sizeField: Buffer) => Buffer.concat([header({ name: "app/a", sizeField }), END]);
    expect(() => read(at(Buffer.from("0000000012x\0", "ascii")))).toThrow(/not an octal field/);
    // GNU base-256 NEGATIVE (0xff lead byte).
    expect(() => read(at(Buffer.alloc(12, 0xff)))).toThrow(/negative or malformed base-256/);
    // Positive base-256 whose magnitude is past a safe integer.
    expect(() => read(at(Buffer.concat([Buffer.from([0x80]), Buffer.alloc(11, 0xff)])))).toThrow(/safe integer/);
  });

  it("reads a correct base-256 size exactly", () => {
    const body = Buffer.alloc(700, 0x62);
    const sizeField = Buffer.alloc(12, 0);
    sizeField[0] = 0x80;
    sizeField.writeUInt16BE(700, 10);
    const tar = Buffer.concat([header({ name: "app/a", sizeField }), pad(body), END]);
    const [only] = read(tar);
    expect(only.size).toBe(700);
    expect(only.content().sha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("REFUSES every header-only typeflag 1–6 that declares a body, instead of striding past it", () => {
    for (const typeflag of ["1", "2", "3", "4", "5", "6"]) {
      // The declared "body" is a whole, valid member — the concealment a stride would hide.
      const concealed = member({ name: "app/hidden.txt" }, Buffer.from(syntheticSecret()));
      const tar = Buffer.concat([header({ name: "app/link", typeflag, size: concealed.length, linkname: "target" }), concealed, END]);
      expect(() => read(tar), `typeflag ${typeflag}`).toThrow(/header-only tar member declares a non-zero body/);
    }
  });

  it("refuses a PAX size record that gives a header-only member a body", () => {
    const tar = Buffer.concat([
      paxMember("x", paxRecord("size", "512")),
      header({ name: "app/dir/", typeflag: "5" }),
      Buffer.alloc(BLOCK, 0x41),
      END,
    ]);
    expect(() => read(tar)).toThrow(/header-only/);
  });

  it("accepts zero padding after the marker, and reports a NON-ZERO trailer as surface or refuses it", () => {
    const base = Buffer.concat([member({ name: "app/a" }, Buffer.from("x")), END]);
    const padded = Buffer.concat([base, Buffer.alloc(4 * BLOCK, 0)]);
    expect(read(padded, { nonzeroTrailer: "refuse" }).map((m) => m.name)).toEqual(["app/a"]);

    const secret = syntheticSecret();
    const trailed = Buffer.concat([base, Buffer.from(secret)]);
    // Surface mode (which requires the recording callback): the trailer is part of the terminator
    // range — reported, never dropped.
    const { ranges } = surfaceOf(trailed, { nonzeroTrailer: "surface", onNonzeroTrailer: () => undefined });
    const terminator = ranges.at(-1)!;
    expect(terminator.kind).toBe("terminator");
    expect(terminator.offset + terminator.length).toBe(trailed.length);
    expect(trailed.subarray(terminator.offset, terminator.offset + terminator.length).toString("latin1")).toContain(secret);
    // …or refused outright, which is the policy for an archive with no scan surface of its own.
    expect(() => read(trailed, { nonzeroTrailer: "refuse" })).toThrow(/non-zero bytes after its end-of-archive/);
  });

  it("accounts for EVERY byte: surface ranges plus member content tile the archive exactly", () => {
    const tar = Buffer.concat([
      paxMember("g", paxRecord("comment", "opaque global")),
      paxMember("x", paxRecord("path", "app/long/é.txt")),
      member({ name: "app/ignored" }, Buffer.from("pax-named")),
      member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/gnu-long-name\0")),
      member({ name: "app/g" }, Buffer.alloc(700, 0x63)),
      header({ name: "app/sym", typeflag: "2", linkname: "../target" }),
      header({ name: "app/hard", typeflag: "1", linkname: "app/g" }),
      header({ name: "app/dir/", typeflag: "5" }),
      member({ name: "app/odd", typeflag: "M" }, Buffer.from("unsupported body")),
      END,
      Buffer.from("trailing"),
    ]);
    const ranges: { offset: number; length: number }[] = [];
    const contents: { offset: number; length: number }[] = [];
    for (const m of readTarMembers(bufferSource(tar), { nonzeroTrailer: "surface", onNonzeroTrailer: () => undefined, onSurface: (r: { offset: number; length: number }) => ranges.push(r) })) {
      if (m.type === "file") contents.push({ offset: m.dataOffset, length: m.size });
    }
    const all = [...ranges, ...contents].filter((r) => r.length > 0).sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    for (const range of all) {
      expect(range.offset).toBe(cursor);
      cursor += range.length;
    }
    expect(cursor).toBe(tar.length);
  });

  it("reports surface ranges in archive order, so adjacent ranges can be joined", () => {
    const tar = Buffer.concat([member({ name: "app/a" }, Buffer.from("x")), member({ name: "app/b" }, Buffer.from("y")), END]);
    const { ranges } = surfaceOf(tar);
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i].offset).toBeGreaterThanOrEqual(ranges[i - 1].offset + ranges[i - 1].length);
    expect(ranges.map((r) => r.kind)).toEqual(["header", "padding", "header", "padding", "terminator"]);
  });
});

// ---------------------------------------------------------------------------
// AC-AUDIT-04 — bounds and time
// ---------------------------------------------------------------------------

/**
 * A VIRTUAL source: claims a large size, serves only the header bytes it holds, and records every
 * requested read length. Nothing large is ever allocated — it throws on any read past its real bytes.
 */
function virtualSource(prefix: Buffer, claimedSize: number) {
  const requests: number[] = [];
  return {
    requests,
    source: {
      size: claimedSize,
      read(position: number, length: number) {
        requests.push(length);
        if (position + length > prefix.length) throw new Error("virtual source: read past the bytes it holds");
        return prefix.subarray(position, position + length);
      },
    },
  };
}

const ONE_MIB = 1024 * 1024;

describe("metadata, physical headers and time are bounded (AC-AUDIT-04)", () => {
  it("refuses a 300 MiB GNU long-name body BEFORE reading it", () => {
    for (const typeflag of ["L", "K", "x", "g"]) {
      const declared = 300 * ONE_MIB;
      const { source, requests } = virtualSource(header({ name: "././@LongLink", typeflag, size: declared }), declared + 4 * BLOCK);
      expect(() => [...readTarMembers(source, { maxMembers: 1 })], `typeflag ${typeflag}`).toThrow(TarLimitError);
      // The only read was the 512-byte header: no body-sized request was ever made.
      expect(Math.max(...requests)).toBe(BLOCK);
    }
  });

  it("accepts a metadata body exactly at the ceiling and refuses one byte more", () => {
    const at = (bytes: number) => Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.alloc(bytes, 0x61)), member({ name: "app/a" }, Buffer.from("x")), END]);
    expect(read(at(2048), { maxMetadataRecordBytes: 2048 })).toHaveLength(1);
    expect(() => read(at(2049), { maxMetadataRecordBytes: 2048 })).toThrow(/2048-byte ceiling/);
  });

  it("bounds ACCUMULATED metadata ahead of one member, not only each record", () => {
    const flood = Array.from({ length: 20 }, (_, i) => paxMember("x", paxRecord(`SCHILY.xattr.user.n${i}`, "v".repeat(200))));
    const tar = Buffer.concat([...flood, member({ name: "app/a" }, Buffer.from("x")), END]);
    expect(() => read(tar, { maxPendingMetadataBytes: 2000 })).toThrow(/ahead of one member/);
    // The same records, but spread across members, reset the accumulation and pass.
    const spread = Buffer.concat([...flood.flatMap((record, i) => [record, member({ name: `app/${i}` }, Buffer.from("x"))]), END]);
    expect(read(spread, { maxPendingMetadataBytes: 2000 })).toHaveLength(20);
  });

  it("counts EVERY physical header — a metadata-only flood cannot bypass the bound", () => {
    const globals = (count: number) => Buffer.concat([...Array.from({ length: count }, () => paxMember("g", paxRecord("comment", "c"))), END]);
    // Metadata-only archive: zero members, so `maxMembers` alone could never stop it.
    expect(read(globals(10), { maxPhysicalHeaders: 10 })).toEqual([]);
    expect(() => read(globals(11), { maxPhysicalHeaders: 10 })).toThrow(/10-header limit/);
    expect(TAR_READER_LIMITS.maxPhysicalHeaders).toBeGreaterThan(500_000);
  });

  it("consults the clock during metadata-only work", () => {
    const tar = Buffer.concat([...Array.from({ length: 8 }, () => paxMember("g", paxRecord("comment", "c"))), END]);
    const consulted: string[] = [];
    const deadline = {
      assert(operation: string) {
        consulted.push(operation);
        if (consulted.length >= 3) throw Object.assign(new Error("deadline"), { code: "STAGING_OPERATION_TIMEOUT" });
      },
    };
    expect(() => read(tar, { deadline, deadlineEveryHeaders: 2 })).toThrow(/deadline/);
    expect(consulted.every((operation) => operation === "tar headers")).toBe(true);
  });

  it("consults the clock inside multi-chunk content hashing", () => {
    const tar = Buffer.concat([member({ name: "app/a" }, Buffer.alloc(4096, 0x61)), END]);
    let calls = 0;
    const deadline = {
      assert(operation: string) {
        calls += 1;
        if (operation === "tar member content") throw Object.assign(new Error("deadline"), { code: "STAGING_OPERATION_TIMEOUT" });
      },
    };
    const [only] = read(tar, { deadline, chunkBytes: 256, deadlineEveryBytes: 1024 });
    const seen: number[] = [];
    expect(() => only.content((chunk: Buffer) => seen.push(chunk.length))).toThrow(/deadline/);
    // Stopped after the first interval — not after the whole member.
    expect(seen.reduce((a, b) => a + b, 0)).toBe(1024);
    expect(calls).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// AC-AUDIT-05 — PAX by bytes
// ---------------------------------------------------------------------------

describe("PAX records are framed by BYTES (AC-AUDIT-05)", () => {
  it("parses independently byte-counted Unicode path and link values, and records after them", () => {
    const records = Buffer.concat([
      paxRecord("SCHILY.xattr.user.note", "ü–数据 before the path"),
      paxRecord("path", "app/é/数据.txt"),
      paxRecord("linkpath", "../ø/目标"),
      paxRecord("size", "3"),
    ]);
    expect(parsePaxRecords(records)).toEqual({ path: "app/é/数据.txt", linkpath: "../ø/目标", size: 3 });
  });

  it("keeps a binary xattr as opaque bytes rather than rejecting it", () => {
    const records = Buffer.concat([paxRecord("SCHILY.xattr.user.bin", Buffer.from([0xff, 0xfe, 0x00, 0x80])), paxRecord("path", "app/x")]);
    expect(parsePaxRecords(records)).toEqual({ path: "app/x" });
  });

  it("refuses malformed digit strings", () => {
    for (const bad of ["012 path=x\n", "+12 path=abc\n", " 12 path=abc\n", "1a path=abc\n", "0 \n"]) {
      expect(() => parsePaxRecords(Buffer.from(bad, "latin1")), JSON.stringify(bad)).toThrow(TarFormatError);
    }
  });

  it("refuses a missing newline, an inconsistent length and a truncated record", () => {
    const good = paxRecord("path", "app/x");
    const noNewline = Buffer.from(good);
    noNewline[noNewline.length - 1] = 0x20;
    expect(() => parsePaxRecords(noNewline)).toThrow(/newline/);
    // Declared one byte SHORTER than the record: the declared end is not a newline.
    const shorter = Buffer.from(`${good.length - 1}${good.subarray(String(good.length).length).toString("latin1")}`, "latin1");
    expect(() => parsePaxRecords(shorter)).toThrow(TarFormatError);
    // Declared LONGER than the bytes present.
    const longer = Buffer.from(`${good.length + 5}${good.subarray(String(good.length).length).toString("latin1")}`, "latin1");
    expect(() => parsePaxRecords(longer)).toThrow(/out of range/);
    expect(() => parsePaxRecords(good.subarray(0, good.length - 3))).toThrow(TarFormatError);
  });

  it("refuses invalid UTF-8 in an INTERPRETED value, without lossy replacement", () => {
    expect(() => parsePaxRecords(paxRecord("path", Buffer.from([0x61, 0xc3, 0x28])))).toThrow(/not valid UTF-8/);
    expect(() => parsePaxRecords(paxRecord("linkpath", Buffer.from([0xff])))).toThrow(/not valid UTF-8/);
  });

  it("refuses a size that is not a strict non-negative decimal", () => {
    for (const bad of ["-1", "1e3", "0x10", " 5", "99999999999999999"]) {
      expect(() => parsePaxRecords(paxRecord("size", bad)), bad).toThrow(TarFormatError);
    }
  });

  it("preserves LOCAL path, link and size overrides for the next member only", () => {
    const body = Buffer.alloc(1500, 0x61);
    const tar = Buffer.concat([
      paxMember("x", Buffer.concat([paxRecord("path", "app/é-long.bin"), paxRecord("size", String(body.length))])),
      header({ name: "app/short", size: 0 }),
      pad(body),
      paxMember("x", paxRecord("linkpath", "../ü")),
      header({ name: "app/sym", typeflag: "2", linkname: "ignored" }),
      member({ name: "app/after" }, Buffer.from("z")),
      END,
    ]);
    const parsed = read(tar);
    expect(parsed.map((m) => m.name)).toEqual(["app/é-long.bin", "app/sym", "app/after"]);
    expect(parsed[0].size).toBe(1500);
    expect(parsed[1].linkTarget).toBe("../ü");
  });

  it("accepts a GLOBAL record carrying only opaque metadata, and reports its bytes as surface", () => {
    const marker = syntheticSecret();
    const tar = Buffer.concat([paxMember("g", paxRecord("SCHILY.xattr.user.note", marker)), member({ name: "app/a" }, Buffer.from("x")), END]);
    const { ranges, members } = surfaceOf(tar);
    expect(members.map((m) => m.name)).toEqual(["app/a"]);
    const metadata = ranges.find((r) => r.kind === "metadata")!;
    expect(tar.subarray(metadata.offset, metadata.offset + metadata.length).toString("latin1")).toContain(marker);
  });

  it("REFUSES an empty path or linkpath value (F2), and an empty GNU long name or link", () => {
    expect(() => parsePaxRecords(paxRecord("path", ""))).toThrow(/empty/);
    expect(() => parsePaxRecords(paxRecord("linkpath", ""))).toThrow(/empty/);
    // The review's exact record: an 8-byte `path=` ahead of a real member.
    const tar = Buffer.concat([paxMember("x", Buffer.from("8 path=\n")), member({ name: "app/planted.js" }, Buffer.from("x")), END]);
    expect(() => read(tar)).toThrow(/empty/);
    for (const typeflag of ["L", "K"]) {
      const gnu = Buffer.concat([member({ name: "././@LongLink", typeflag }, Buffer.from("\0")), member({ name: "app/a" }, Buffer.from("x")), END]);
      expect(() => read(gnu), typeflag).toThrow(/empty/);
    }
  });

  it("reports a non-zero trailer to the caller exactly once, and not for zero padding (F1)", () => {
    const base = Buffer.concat([member({ name: "app/a" }, Buffer.from("x")), END]);
    let told = 0;
    read(Buffer.concat([base, Buffer.alloc(BLOCK, 0), Buffer.from("PK\x03\x04"), Buffer.alloc(BLOCK, 0x41)]), { nonzeroTrailer: "surface", onNonzeroTrailer: () => { told += 1; } });
    expect(told).toBe(1);
    told = 0;
    read(Buffer.concat([base, Buffer.alloc(4 * BLOCK, 0)]), { nonzeroTrailer: "surface", onNonzeroTrailer: () => { told += 1; } });
    expect(told).toBe(0);
  });

  it("REFUSES a global path, linkpath or size override", () => {
    for (const key of ["path", "linkpath", "size"]) {
      const tar = Buffer.concat([paxMember("g", paxRecord(key, key === "size" ? "1" : "app/x")), member({ name: "app/a" }, Buffer.from("x")), END]);
      expect(() => read(tar), key).toThrow(/global PAX header overrides/);
    }
  });

  it("the shared fixture writer now byte-counts its PAX lengths too", () => {
    const name = `app/${"é".repeat(60)}/数据.txt`;
    const [only] = read(buildTar([{ name, content: "u", paxLongName: true }]));
    expect(only.name).toBe(name);
  });
});
