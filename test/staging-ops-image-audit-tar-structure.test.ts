import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TAR_READER_LIMITS,
  TarFormatError,
  TarLimitError,
  bufferSource,
  canonicalMemberPath,
  MEMBER_PATH_LIMITS,
  assertMemberPathBounded,
  isChecksumValidTarHeader,
  parsePaxRecords,
  readTarMembers,
} from "../scripts/staging-ops/image-audit/tar-reader.mjs";
import { mergedFilesystem, whiteoutOf } from "../scripts/staging-ops/image-audit/layers.mjs";
import { membersThroughSymlink } from "../scripts/staging-ops/image-audit/inspect.mjs";
import { createRetainedStateBudget, createWorkBudget } from "../scripts/staging-ops/image-audit/budgets.mjs";
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
    // A flood of repeated LOCAL `x` headers is now refused structurally, before any bound (B2)…
    expect(() => read(Buffer.concat([...flood, member({ name: "app/a" }, Buffer.from("x")), END]), { maxPendingMetadataBytes: 2000 }))
      .toThrow(/repeated local PAX header/);
    // …so the accumulation bound is exercised with the metadata still LEGAL ahead of one member: one
    // `x`, one GNU `L` and one GNU `K`, which together pass a total no single record reaches.
    const legal = Buffer.concat([
      paxMember("x", paxRecord("SCHILY.xattr.user.note", "v".repeat(900))),
      member({ name: "././@LongLink", typeflag: "L" }, Buffer.from(`app/${"n".repeat(700)}\0`)),
      member({ name: "././@LongLink", typeflag: "K" }, Buffer.from(`${"t".repeat(700)}\0`)),
      header({ name: "app/sym", typeflag: "2", linkname: "short" }),
      END,
    ]);
    expect(() => read(legal, { maxPendingMetadataBytes: 2000 })).toThrow(/ahead of one member/);
    expect(read(legal, { maxPendingMetadataBytes: 4000 })).toHaveLength(1);
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

  it("REFUSES a NUL anywhere in an interpreted path or linkpath, byte-counted", () => {
    for (const [key, value] of [["path", "app/x\0y"], ["path", "\0"], ["linkpath", "\0"], ["linkpath", "../t\0"]] as const) {
      expect(() => parsePaxRecords(paxRecord(key, Buffer.from(value, "utf8"))), `${key}=${JSON.stringify(value)}`).toThrow(/NUL byte/);
    }
    // An opaque value may carry NULs: it is scanned, never interpreted.
    expect(parsePaxRecords(Buffer.concat([paxRecord("SCHILY.xattr.user.b", Buffer.from([0, 1, 0])), paxRecord("path", "app/x")]))).toEqual({ path: "app/x" });
  });

  it("PRESERVES a leading byte-order mark in an interpreted value instead of stripping it", () => {
    const bom = "\uFEFFapp/bom.txt";
    expect(parsePaxRecords(paxRecord("path", bom))).toEqual({ path: bom });
    const [only] = read(Buffer.concat([paxMember("x", paxRecord("path", bom)), member({ name: "app/plain" }, Buffer.from("x")), END]));
    expect(only.name).toBe(bom);
    expect(only.name).not.toBe("app/bom.txt");
  });

  it("refuses a non-zero trailer BY DEFAULT, and refuses surface mode without a recording callback", () => {
    const trailed = Buffer.concat([member({ name: "app/a" }, Buffer.from("x")), END, Buffer.from("PK\x03\x04")]);
    expect(() => read(trailed)).toThrow(/non-zero bytes after its end-of-archive/);
    expect(() => read(trailed, { nonzeroTrailer: "surface" })).toThrow(/requires an onNonzeroTrailer callback/);
    expect(() => read(trailed, { nonzeroTrailer: "scan" })).toThrow(/must be "refuse" or "surface"/);
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

// ---------------------------------------------------------------------------
// B1/B2 — one header rule, one canonical path, no ambiguous metadata
// ---------------------------------------------------------------------------

/** A magic-less V7 header: the ustar magic and version cleared, checksum recomputed. */
function v7Header(spec: RawHeader): Buffer {
  const block = header(spec);
  block.fill(0, 257, 265);
  block.write("        ", 148, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

describe("the reader's first-header rule is exported and bounded (B1)", () => {
  it("accepts a checksum-valid ustar or V7 header and nothing else", () => {
    expect(isChecksumValidTarHeader(header({ name: "app/a" }))).toBe(true);
    const v7 = v7Header({ name: "app/a" });
    expect(v7.subarray(257, 262).toString("latin1")).not.toBe("ustar");
    expect(isChecksumValidTarHeader(v7)).toBe(true);
    // …and the reader agrees: the same bytes read as a tar.
    expect(read(Buffer.concat([v7, END])).map((m) => m.name)).toEqual(["app/a"]);
    expect(isChecksumValidTarHeader(Buffer.alloc(BLOCK, 0))).toBe(false);
    expect(isChecksumValidTarHeader(Buffer.alloc(BLOCK, 0x41))).toBe(false);
    expect(isChecksumValidTarHeader(header({ name: "app/a" }).subarray(0, BLOCK - 1))).toBe(false);
    const corrupt = header({ name: "app/a" });
    corrupt[0] ^= 1;
    expect(isChecksumValidTarHeader(corrupt)).toBe(false);
  });
});

describe("one canonical member path (B2)", () => {
  it("collapses repeated / and . segments, preserving Unicode and case", () => {
    const accepted: [string, string | undefined, string][] = [
      ["././app/planted.js", "file", "app/planted.js"],
      [".//app/planted.js", "file", "app/planted.js"],
      ["app/./sub//x.js", "file", "app/sub/x.js"],
      ["App/É/数据.JS", "file", "App/É/数据.JS"],
      ["app/dir/", "directory", "app/dir/"],
      ["./app//dir/./", "directory", "app/dir/"],
      ["./", "directory", "."],
      // B6: a DIRECTORY's key is type-driven — written without a slash, it still ends in one.
      ["app/dir", "directory", "app/dir/"],
      ["./app//dir", "directory", "app/dir/"],
      [".", "directory", "."],
    ];
    for (const [name, type, path] of accepted) expect(canonicalMemberPath(name, type), name).toEqual({ ok: true, path });
  });

  it("refuses what depends on the host: .., absolute, drive, backslash, empty, NUL, a trailing slash on a file or link", () => {
    const refused: [string, string | undefined, string][] = [
      ["app/../x", "file", "traversal"],
      ["/app/x", "file", "absolute"],
      ["C:/app/x", "file", "absolute"],
      ["app\\x.js", "file", "backslash"],
      ["", "file", "empty"],
      ["./", "file", "empty"],
      ["app/\0x", "file", "nul-byte"],
      ["app/x.js/", "file", "trailing-slash"],
      ["app/link/", "symlink", "trailing-slash"],
    ];
    for (const [name, type, reason] of refused) expect(canonicalMemberPath(name, type), JSON.stringify(name)).toEqual({ ok: false, reason });
  });

  it("is what every member carries, resolved AFTER ustar/PAX/GNU", () => {
    const tar = Buffer.concat([
      paxMember("x", paxRecord("path", "app/.//pax.js")), header({ name: "ignored" }),
      member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("./app//gnu.js\0")), header({ name: "ignored" }),
      header({ name: "./app/./plain.js" }),
      END,
    ]);
    expect(read(tar).map((m) => m.canonicalName)).toEqual(["app/pax.js", "app/gnu.js", "app/plain.js"]);
  });
});

describe("ambiguous extended metadata is refused, whatever order it arrives in (B2)", () => {
  const planted = () => header({ name: "app/planted.js" });
  const refusals: [string, Buffer, RegExp][] = [
    ["a repeated local x (even opaque-only)", Buffer.concat([paxMember("x", paxRecord("path", "decoy")), paxMember("x", paxRecord("comment", "c")), planted(), END]), /repeated local PAX header/],
    ["a g while a local x is pending", Buffer.concat([paxMember("x", paxRecord("path", "decoy")), paxMember("g", paxRecord("comment", "c")), planted(), END]), /global PAX header arrives while member metadata is pending/],
    ["a g while a GNU long name is pending", Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/x\0")), paxMember("g", paxRecord("comment", "c")), planted(), END]), /global PAX header arrives/],
    ["a g while a GNU long link is pending", Buffer.concat([member({ name: "././@LongLink", typeflag: "K" }, Buffer.from("t\0")), paxMember("g", paxRecord("comment", "c")), planted(), END]), /global PAX header arrives/],
    ["GNU L then PAX path", Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/planted.js\0")), paxMember("x", paxRecord("path", "decoy")), planted(), END]), /both describe one member/],
    ["PAX path then GNU L", Buffer.concat([paxMember("x", paxRecord("path", "decoy")), member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/planted.js\0")), planted(), END]), /both describe one member/],
    ["GNU K then PAX linkpath", Buffer.concat([member({ name: "././@LongLink", typeflag: "K" }, Buffer.from("a\0")), paxMember("x", paxRecord("linkpath", "b")), header({ name: "app/s", typeflag: "2" }), END]), /both describe one member/],
    ["PAX linkpath then GNU K", Buffer.concat([paxMember("x", paxRecord("linkpath", "b")), member({ name: "././@LongLink", typeflag: "K" }, Buffer.from("a\0")), header({ name: "app/s", typeflag: "2" }), END]), /both describe one member/],
    ["a repeated GNU L", Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("a\0")), member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("b\0")), planted(), END]), /repeated GNU long name/],
    ["a local GNU.sparse key", Buffer.concat([paxMember("x", Buffer.concat([paxRecord("GNU.sparse.major", "1"), paxRecord("GNU.sparse.name", "app/planted.js")])), planted(), END]), /GNU.sparse/],
    ["a global GNU.sparse key", Buffer.concat([paxMember("g", paxRecord("GNU.sparse.name", "app/planted.js")), planted(), END]), /GNU.sparse/],
  ];
  for (const [label, tar, message] of refusals) {
    it(`refuses ${label}`, () => {
      expect(() => read(tar)).toThrow(TarFormatError);
      expect(() => read(tar)).toThrow(message);
    });
  }

  it("keeps ordinary PAX and GNU metadata working", () => {
    const tar = Buffer.concat([
      paxMember("g", paxRecord("comment", "global, nothing pending")),
      paxMember("x", paxRecord("comment", "opaque only")), header({ name: "app/a" }),
      paxMember("x", Buffer.concat([paxRecord("path", "app/long.js"), paxRecord("SCHILY.xattr.user.n", "v")])), header({ name: "ignored" }),
      member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/gnu-long.js\0")), header({ name: "ignored" }),
      // A GNU long NAME and a PAX LINKPATH describe different fields and do not conflict.
      member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/sym\0")), paxMember("x", paxRecord("linkpath", "target")), header({ name: "ignored", typeflag: "2" }),
      END,
    ]);
    expect(read(tar).map((m) => [m.canonicalName, m.linkTarget])).toEqual([["app/a", ""], ["app/long.js", ""], ["app/gnu-long.js", ""], ["app/sym", "target"]]);
  });
});

// ---------------------------------------------------------------------------
// B3/B4 — header format decides the name; one strict octal rule
// ---------------------------------------------------------------------------

/**
 * A header in a chosen FORMAT, independent of the reader: the magic/version per Go's `getFormat`, an
 * optional region written at byte 345, an optional STAR trailer at 508, checksum recomputed.
 */
function formatHeader(spec: RawHeader & { format: "posix" | "gnu" | "v7" | "star"; region?: Buffer; regionAt?: number }): Buffer {
  const block = header(spec);
  block.fill(0, 257, 265);
  if (spec.format === "posix" || spec.format === "star") { block.write("ustar\0", 257, "latin1"); block.write("00", 263, "latin1"); }
  if (spec.format === "gnu") { block.write("ustar ", 257, "latin1"); block.write(" \0", 263, "latin1"); }
  if (spec.format === "star") block.write("tar\0", 508, "latin1");
  if (spec.region) spec.region.copy(block, spec.regionAt ?? 345);
  block.write("        ", 148, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

describe("the header FORMAT decides whether bytes 345–500 are a name prefix (B3)", () => {
  const withBody = (block: Buffer) => Buffer.concat([block, END]);

  it("applies the 155-byte prefix for POSIX ustar only", () => {
    const [only] = read(withBody(formatHeader({ name: "ok.js", format: "posix", region: Buffer.from("app") })));
    expect(only.canonicalName).toBe("app/ok.js");
  });

  it("REFUSES a V7 header whose bytes at 345 would have named a planted file differently", () => {
    expect(() => read(withBody(formatHeader({ name: "app/planted.js", format: "v7", region: Buffer.from("decoy") }))))
      .toThrow(/a v7 tar header carries bytes where only POSIX ustar has a name prefix/);
  });

  it("REFUSES a GNU header carrying an atime (a valid number) at 345", () => {
    expect(() => read(withBody(formatHeader({ name: "app/planted.js", format: "gnu", region: Buffer.from("00000000001\0") }))))
      .toThrow(/a gnu tar header carries bytes/);
  });

  it("REFUSES a STAR layout with a prefix or with times at 476–500", () => {
    expect(() => read(withBody(formatHeader({ name: "planted.js", format: "star", region: Buffer.from("app") })))).toThrow(/a star tar header/);
    expect(() => read(withBody(formatHeader({ name: "app/planted.js", format: "star", region: Buffer.from("00000000001\0"), regionAt: 476 })))).toThrow(/a star tar header/);
  });

  it("keeps V7, GNU and STAR headers with a zero region, and GNU metadata members", () => {
    for (const format of ["v7", "gnu", "star"] as const) {
      const [only] = read(withBody(formatHeader({ name: "app/ok.js", format })));
      expect(only.canonicalName, format).toBe("app/ok.js");
    }
    // `ustar ` with a non-GNU version is V7 to Go, and a zero region keeps it valid here.
    const odd = formatHeader({ name: "app/ok.js", format: "gnu" });
    odd.write("xx", 263, "latin1");
    odd.write("        ", 148, "ascii");
    let sum = 0;
    for (const byte of odd) sum += byte;
    odd.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    expect(read(withBody(odd))[0].canonicalName).toBe("app/ok.js");
  });
});

describe("one octal rule for checksum, size and mode (B4)", () => {
  const sizeHeader = (sizeField: Buffer, name = "app/empty.txt") => header({ name, sizeField });

  it("reads a LEADING-NUL size as its real value, never as 0 with a phantom member", () => {
    const body = Buffer.concat([header({ name: "tmp/decoy", size: 0 }), Buffer.alloc(0)]);
    expect(body.length).toBe(BLOCK);
    const sizeField = Buffer.concat([Buffer.from([0]), Buffer.from("0000001000", "ascii"), Buffer.from([0])]);
    const tar = Buffer.concat([sizeHeader(sizeField), body, END]);
    const parsed = read(tar);
    expect(parsed.map((m) => [m.name, m.size])).toEqual([["app/empty.txt", 512]]);
    expect(parsed[0].content().sha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("accepts ordinary NUL and space padding at either end", () => {
    for (const field of ["00000001000\0", "     1000 \0\0", "\0\0 0001000  ", "1000        "]) {
      const tar = Buffer.concat([sizeHeader(Buffer.from(field, "latin1")), Buffer.alloc(BLOCK, 0x61), END]);
      expect(read(tar)[0].size, JSON.stringify(field)).toBe(512);
    }
  });

  it("REFUSES an interior NUL, an interior space or any non-octal byte", () => {
    for (const field of ["0000\x00001000\0", "0000 001000\0", "00000001008\0", "0000000100x\0"]) {
      const tar = Buffer.concat([sizeHeader(Buffer.from(field, "latin1")), Buffer.alloc(BLOCK, 0x61), END]);
      expect(() => read(tar), JSON.stringify(field)).toThrow(/is not an octal field/);
    }
  });

  it("keeps positive base-256, and refuses negative or unsafe base-256", () => {
    const positive = Buffer.alloc(12, 0);
    positive[0] = 0x80;
    positive.writeUInt16BE(512, 10);
    expect(read(Buffer.concat([sizeHeader(positive), Buffer.alloc(BLOCK, 0x61), END]))[0].size).toBe(512);
    expect(() => read(Buffer.concat([sizeHeader(Buffer.alloc(12, 0xff)), END]))).toThrow(/negative or malformed base-256/);
    expect(() => read(Buffer.concat([sizeHeader(Buffer.concat([Buffer.from([0x80]), Buffer.alloc(11, 0xff)])), END]))).toThrow(/safe integer/);
  });

  it("applies the same rule to the checksum and mode, and never accepts a blank checksum", () => {
    const blank = header({ name: "app/a" });
    blank.fill(0x20, 148, 156);
    expect(() => read(Buffer.concat([blank, END]))).toThrow(/carries no checksum/);
    // A checksum written with a LEADING NUL still verifies: the same trim as every other field.
    const leading = header({ name: "app/a" });
    const digits = leading.subarray(148, 154).toString("latin1");
    leading.write(`\0${digits}\0`, 148, "latin1");
    expect(read(Buffer.concat([leading, END]))[0].name).toBe("app/a");
    // An interior NUL in the mode is refused like one in the size.
    const mode = header({ name: "app/a" });
    mode.write("000\u0000644\0", 100, "latin1");
    expect(mode[103]).toBe(0);
    mode.write("        ", 148, "ascii");
    let sum = 0;
    for (const byte of mode) sum += byte;
    mode.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    expect(() => read(Buffer.concat([mode, END]))).toThrow(/mode is not an octal field/);
  });
});

describe("merge rules at unit level (B6)", () => {
  it("reads a whiteout's basename after one trailing slash", () => {
    expect(whiteoutOf("app/.wh.d/")).toEqual({ kind: "delete", target: "app/d" });
    expect(whiteoutOf("app/d/.wh..wh..opq/")).toEqual({ kind: "opaque", target: "app/d/" });
    expect(whiteoutOf("app/d/")).toEqual({ kind: "none" });
  });

  it("replaces by type across layers, merges directories, and flags same-layer ambiguity", () => {
    const fileOverDir = mergedFilesystem([["app/", "app/d/", "app/d/x.js", "app/dx.js"], ["app/d"]]);
    expect([...fileOverDir.visible.keys()].sort()).toEqual(["app/", "app/d", "app/dx.js"]);
    expect(fileOverDir.conflicts).toEqual([]);
    const dirOverFile = mergedFilesystem([["app/", "app/cfg"], ["app/cfg/"]]);
    expect([...dirOverFile.visible.keys()].sort()).toEqual(["app/", "app/cfg/"]);
    const dirOverDir = mergedFilesystem([["app/", "app/d/", "app/d/x.js"], ["app/d/", "app/d/y.js"]]);
    expect([...dirOverDir.visible.keys()].sort()).toEqual(["app/", "app/d/", "app/d/x.js", "app/d/y.js"]);
    expect(mergedFilesystem([["app/z", "app/z/q.js"]]).conflicts).toEqual([0]);
    expect(mergedFilesystem([["app/z", "app/z/"]]).conflicts).toEqual([0]);
    expect(mergedFilesystem([["app/f"], ["app/f/inner.js"]]).conflicts).toEqual([1]);
    // …but a directory REPLACING the lower file in the same layer is not ambiguous.
    expect(mergedFilesystem([["app/f"], ["app/f/", "app/f/inner.js"]]).conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B9 — bounded member-path work (AC-AUDIT-04)
// ---------------------------------------------------------------------------

describe("member paths are bounded before any ancestor work (B9)", () => {
  const limitCode = { code: "AUDIT_TAR_LIMIT_EXCEEDED" };

  it("accepts exactly 4,096 UTF-8 bytes and refuses one more, counting BYTES not characters", () => {
    expect(MEMBER_PATH_LIMITS).toEqual({ maxBytes: 4096, maxSegments: 128 });
    expect(() => assertMemberPathBounded("a".repeat(4096))).not.toThrow();
    expect(() => assertMemberPathBounded("a".repeat(4097))).toThrow(expect.objectContaining(limitCode));
    // 2,048 two-byte characters are exactly 4,096 bytes; one more byte, or one more character, is over.
    expect(() => assertMemberPathBounded("é".repeat(2048))).not.toThrow();
    expect(() => assertMemberPathBounded(`${"é".repeat(2048)}a`)).toThrow(expect.objectContaining(limitCode));
    expect(() => assertMemberPathBounded("é".repeat(2049))).toThrow(/4096-byte/);
  });

  it("accepts exactly 128 segments and refuses 129; a directory's trailing slash is not a segment", () => {
    const segments = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`).join("/");
    expect(() => assertMemberPathBounded(segments(128))).not.toThrow();
    expect(() => assertMemberPathBounded(`${segments(128)}/`)).not.toThrow();
    expect(() => assertMemberPathBounded(segments(129))).toThrow(/128-segment/);
    expect(canonicalMemberPath(segments(128), "file")).toEqual({ ok: true, path: segments(128) });
    expect(() => canonicalMemberPath(segments(129), "file")).toThrow(expect.objectContaining(limitCode));
    // Unsafe names are bounded too — before they are classified.
    expect(() => canonicalMemberPath(`/${segments(129)}`, "file")).toThrow(expect.objectContaining(limitCode));
  });

  it("refuses a 250,000-segment PAX path at READ time, before any member is yielded", () => {
    const deep = `${"a/".repeat(250_000)}x`;
    const record = paxRecord("path", deep);
    expect(record.length).toBeLessThan(TAR_READER_LIMITS.maxMetadataRecordBytes);
    const tar = Buffer.concat([paxMember("x", record), header({ name: "short" }), END]);
    const seen: string[] = [];
    expect(() => { for (const m of readTarMembers(bufferSource(tar))) seen.push(m.name); }).toThrow(TarLimitError);
    expect(seen).toEqual([]);
  });

  it("direct helper callers are bounded too", () => {
    const deep = `${"a/".repeat(200)}x`;
    expect(() => mergedFilesystem([[deep]])).toThrow(expect.objectContaining(limitCode));
    expect(() => membersThroughSymlink([deep], new Set(["a"]))).toThrow(expect.objectContaining(limitCode));
  });

  it("refuses when aggregate ancestor work passes an injected budget", () => {
    const paths = Array.from({ length: 10 }, (_, i) => `a/b/c/d/f${i}`);
    expect(() => mergedFilesystem([paths], { work: createWorkBudget({ maxSteps: 20 }) })).toThrow(expect.objectContaining(limitCode));
    expect(() => mergedFilesystem([paths], { work: createWorkBudget({ maxSteps: 10_000 }) })).not.toThrow();
  });

  const expiring = (after: number, only?: string) => {
    const asked: string[] = [];
    return {
      asked,
      assert(operation: string) {
        if (only !== undefined && operation !== only) return;
        asked.push(operation);
        if (asked.length >= after) throw Object.assign(new Error("deadline"), { code: "STAGING_OPERATION_TIMEOUT" });
      },
    };
  };

  it("consults the clock INSIDE one path, across paths, and during subtree removal", () => {
    // Inside ONE path: six ancestors, expiry on the third check.
    const one = expiring(3);
    expect(() => mergedFilesystem([["a/b/c/d/e/f/g"]], { work: createWorkBudget({ deadline: one, deadlineEvery: 1 }) })).toThrow(/deadline/);
    expect(one.asked.length).toBe(3);
    // Across paths: one ancestor each, expiry part-way through the list.
    const across = expiring(5);
    expect(() => mergedFilesystem([Array.from({ length: 20 }, (_, i) => `d/f${i}`)], { work: createWorkBudget({ deadline: across, deadlineEvery: 1 }) })).toThrow(/deadline/);
    // During the removal of a whited-out subtree.
    const removal = expiring(2, "merged namespace removal");
    expect(() => mergedFilesystem([["d/", ...Array.from({ length: 10 }, (_, i) => `d/f${i}`)], ["x", ".wh.d"]], { work: createWorkBudget({ deadline: removal, deadlineEvery: 1 }) })).toThrow(/deadline/);
  });

  it("the symlink-ancestry check consults the clock inside a single path", () => {
    const one = expiring(2);
    expect(() => membersThroughSymlink(["a/b/c/d/e"], new Set(["zz"]), one, { deadlineEvery: 1 })).toThrow(/deadline/);
    expect(one.asked).toEqual(["symlink ancestry", "symlink ancestry"]);
  });
});
