import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { AUDIT_LIMITS } from "../scripts/staging-ops/image-audit/subject.mjs";
import { createStagingBudget, inventoryLayer } from "../scripts/staging-ops/image-audit/export-walk.mjs";
import { SCAN_HEADER, archiveSurfaceGroup } from "../scripts/staging-ops/image-audit/scan-surface.mjs";
import { transitionReadiness } from "../scripts/staging-ops/image-audit/evidence.mjs";
import { compareInventory, expectedInventory, inventorySummary } from "../scripts/staging-ops/image-audit/expected-tree.mjs";
import { latestAppMembers } from "../scripts/staging-ops/image-audit/inspect.mjs";
import { mergedFilesystem } from "../scripts/staging-ops/image-audit/layers.mjs";
import { buildTar, syntheticSecret } from "./helpers/tar-fixture";
import { inspectSynthetic, memberScanFiles, scanSurface, scratchPool, surfaceScanFiles, synthesizeImage } from "./helpers/synthetic-image";

/**
 * AC-AUDIT-02/03/04 through the FULL inspector, on correctly hashed synthetic images.
 *
 * THE WITNESSES THESE REPLACE. An independent review drove the inspector over a valid layer with a
 * plaintext marker (a) after the end blocks, (b) in a PAX extended attribute, (c) in a symlink target,
 * and (d) as a short non-tar "layer". All four returned `identityVerified: true`, `coverage.complete:
 * true`, no limitations — and the marker was on no staged scan file. Every case below asserts the
 * marker now reaches the scan surface UNCHANGED, or the run records incomplete coverage / refuses.
 *
 * Every image is correctly hashed, so identity success cannot mask a structural failure.
 */

const pool = scratchPool();
afterAll(() => pool.cleanup());

const BLOCK = 512;
const END = Buffer.alloc(2 * BLOCK, 0);

/** A checksummed ustar header written from the layout, with an optional marker in `uname`. */
function header({ name, size = 0, typeflag = "0", linkname = "", uname = "", prefix = "", v7 = false, gnu = false, region }: { name: string; size?: number; typeflag?: string; linkname?: string; uname?: string; prefix?: string; v7?: boolean; gnu?: boolean; region?: Buffer }): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(typeflag, 156, 1, "latin1");
  block.write(linkname, 157, 100, "utf8");
  // A V7 header carries no magic or version at all.
  if (gnu) {
    block.write("ustar ", 257, "ascii");
    block.write(" \0", 263, "latin1");
  } else if (!v7) {
    block.write("ustar\0", 257, "ascii");
    block.write("00", 263, "ascii");
  }
  block.write(uname, 265, 32, "utf8");
  if (prefix) block.write(prefix, 345, 155, "utf8");
  // Raw bytes at 345, whatever the format makes of them (B3).
  if (region) region.copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** Padding that is NOT zero — a writer is free to leave anything there, and it ships. */
const padWith = (body: Buffer, filler: Buffer) => {
  const gap = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return Buffer.concat([body, Buffer.concat([filler, Buffer.alloc(BLOCK, 0)]).subarray(0, gap)]);
};

function paxRecord(key: string, value: string): Buffer {
  const tail = Buffer.from(` ${key}=${value}\n`, "utf8");
  for (let digits = 1; digits < 12; digits += 1) {
    if (String(digits + tail.length).length === digits) return Buffer.concat([Buffer.from(String(digits + tail.length)), tail]);
  }
  throw new Error("unreachable");
}

const member = (spec: Parameters<typeof header>[0], body = Buffer.alloc(0), filler = Buffer.alloc(0)) =>
  Buffer.concat([header({ ...spec, size: spec.size ?? body.length }), padWith(body, filler)]);

async function inspectLayers(layers: Buffer[], limits: Partial<typeof AUDIT_LIMITS> = {}) {
  return inspectSynthetic(synthesizeImage(layers), pool.make(), limits);
}

/** The marker must be on the staged surface, byte for byte, or coverage must be incomplete. */
function expectCoveredOrIncomplete(result: Awaited<ReturnType<typeof inspectLayers>>, marker: string) {
  const onSurface = scanSurface(result.scanDir).includes(marker);
  expect(onSurface || result.coverage.complete === false, "marker neither scanned nor reported").toBe(true);
}

/** …and nothing about it may reach what the audit PUBLISHES from the inspection. */
function expectNotPublished(result: Awaited<ReturnType<typeof inspectLayers>>, marker: string) {
  const published = JSON.stringify({ coverage: result.coverage, layers: result.layers, buildOutputs: result.buildOutputs });
  expect(published).not.toContain(marker);
}

describe("every distributed archive byte reaches the scan surface (AC-AUDIT-02)", () => {
  it("POSITIVE: ordinary ustar, PAX and GNU members, links and zero padding give complete coverage", async () => {
    const result = await inspectLayers([buildTar([
      { name: "app/", type: "directory" },
      { name: "app/index.js", content: "export const ok = true;\n" },
      { name: `app/${"deep/".repeat(30)}pax.js`, content: "1", paxLongName: true },
      { name: `app/${"gnu/".repeat(40)}gnu.js`, content: "2", gnuLongName: true },
      { name: "app/sym", type: "symlink", linkTarget: "index.js" },
      { name: "app/hard", type: "hardlink", linkTarget: "app/index.js" },
    ])]);
    expect(result.identityVerified).toBe(true);
    expect(result.coverage.limitations).toEqual([]);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.archiveSurfaceBytes).toBeGreaterThan(0);
    // Links stay METADATA: recorded as links, never resolved and never staged as content.
    expect(result.appMembers.filter((m) => m.type === "symlink").map((m) => m.path)).toEqual(["app/sym", "app/hard"]);
    expect(memberScanFiles(join(result.scanDir, "L0"))).toHaveLength(3);
  });

  it("POSITIVE: the canonical empty tar is a valid, completely covered layer", async () => {
    const result = await inspectLayers([Buffer.from(END)]);
    expect(result.identityVerified).toBe(true);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.members).toBe(0);
    // Its two end blocks are the whole layer, and they are the whole surface.
    expect(result.coverage.archiveSurfaceBytes).toBe(2 * BLOCK);
  });

  const cases: { label: string; layer: (marker: string) => Buffer }[] = [
    {
      label: "a PAX extended attribute (local)",
      layer: (marker) => Buffer.concat([member({ name: "PaxHeader/a", typeflag: "x" }, paxRecord("SCHILY.xattr.user.note", marker)), member({ name: "app/a" }, Buffer.from("x")), END]),
    },
    {
      label: "a PAX global record",
      layer: (marker) => Buffer.concat([member({ name: "PaxHeader/g", typeflag: "g" }, paxRecord("comment", marker)), member({ name: "app/a" }, Buffer.from("x")), END]),
    },
    {
      label: "a GNU long-name record",
      layer: (marker) => Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.from(`app/${marker}\0`)), member({ name: "app/short" }, Buffer.from("x")), END]),
    },
    {
      label: "a GNU long-link record",
      layer: (marker) => Buffer.concat([member({ name: "././@LongLink", typeflag: "K" }, Buffer.from(`../${marker}\0`)), header({ name: "app/sym", typeflag: "2", linkname: "short" }), END]),
    },
    {
      label: "a symlink target",
      layer: (marker) => Buffer.concat([header({ name: "app/sym", typeflag: "2", linkname: marker }), END]),
    },
    {
      label: "a header field the filesystem view ignores (uname)",
      layer: (marker) => Buffer.concat([member({ name: "app/a", uname: marker.slice(0, 31) }, Buffer.from("x")), END]),
    },
    {
      label: "member padding",
      layer: (marker) => Buffer.concat([member({ name: "app/a" }, Buffer.from("x"), Buffer.from(`\n${marker}\n`)), END]),
    },
    {
      label: "the body of an unsupported typeflag",
      layer: (marker) => Buffer.concat([member({ name: "app/odd", typeflag: "M" }, Buffer.from(`TOKEN=${marker}\n`)), END]),
    },
    {
      label: "trailing bytes after the end-of-archive blocks",
      layer: (marker) => Buffer.concat([member({ name: "app/a" }, Buffer.from("x")), END, Buffer.from(marker)]),
    },
  ];

  for (const { label, layer } of cases) {
    it(`NEGATIVE: a marker in ${label} reaches the scan surface unchanged, and is not published`, async () => {
      const marker = syntheticSecret();
      // `uname` holds 32 bytes, so that case carries a 31-byte prefix of the marker.
      const probe = label.includes("uname") ? marker.slice(0, 31) : marker;
      const result = await inspectLayers([layer(marker)]);
      expect(result.identityVerified).toBe(true);
      expect(scanSurface(result.scanDir)).toContain(probe);
      // It reached the surface through the ARCHIVE-METADATA files specifically, not by luck.
      const surface = surfaceScanFiles(result.scanDir).map((path) => readFileSync(path, "latin1")).join("");
      expect(surface).toContain(probe);
      expectCoveredOrIncomplete(result, probe);
      expectNotPublished(result, probe);
    });
  }

  it("keeps an unsupported member's LIMITATION alongside staging its body as opaque bytes", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([cases[7].layer(marker)]);
    expect(result.coverage.limitations).toContainEqual({ kind: "unsupported-member-type", layer: 0, typeflag: "M" });
    expect(result.coverage.complete).toBe(false);
  });

  it("stages the metadata of a tar DECODED FROM GZIP inside a layer", async () => {
    const marker = syntheticSecret();
    const inner = Buffer.concat([
      member({ name: "PaxHeader/i", typeflag: "x" }, paxRecord("SCHILY.xattr.user.note", marker)),
      member({ name: "fixture/a.txt" }, Buffer.from("inner")),
      END,
    ]);
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tgz", content: gzipSync(inner) }])]);
    expect(result.coverage.limitations).toEqual([]);
    const surface = surfaceScanFiles(result.scanDir).map((path) => readFileSync(path, "latin1")).join("");
    expect(surface).toContain(marker);
  });

  it("does NOT stage an uncompressed nested tar's metadata twice — its bytes were already member content", async () => {
    const marker = syntheticSecret();
    const inner = Buffer.concat([member({ name: "PaxHeader/i", typeflag: "x" }, paxRecord("SCHILY.xattr.user.note", marker)), member({ name: "a" }, Buffer.from("i")), END]);
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tar", content: inner }])]);
    const members = memberScanFiles(result.scanDir).map((path) => readFileSync(path, "latin1")).join("");
    const surface = surfaceScanFiles(result.scanDir).map((path) => readFileSync(path, "latin1")).join("");
    expect(members).toContain(marker);
    expect(surface).not.toContain(marker);
  });

  it("keeps each range WHOLE: one too large for a surface file is a recorded limitation, never split", async () => {
    const marker = syntheticSecret();
    const body = Buffer.concat([Buffer.alloc(3000, 0x2e), Buffer.from(marker)]);
    const result = await inspectLayers([Buffer.concat([member({ name: "app/odd", typeflag: "M" }, body), END])], {
      maxArchiveSurfaceFileBytes: 2048,
    });
    expect(result.coverage.limitations).toContainEqual({ kind: "archive-surface-range-unstageable", layer: 0 });
    expect(result.coverage.complete).toBe(false);
    for (const path of surfaceScanFiles(result.scanDir)) {
      expect(readFileSync(path).length).toBeLessThanOrEqual(SCAN_HEADER.length + 2048);
    }
  });

  it("charges the surface to the total allowance and records the refusal", async () => {
    const layer = buildTar([{ name: "app/a", content: "x" }]);
    const result = await inspectLayers([layer], { maxTotalStagedBytes: 1 + 512 });
    expect(result.coverage.limitations).toContainEqual({ kind: "total-staging-budget-exhausted", layer: 0 });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.stagedBytes).toBeLessThanOrEqual(513);
  });

  it("charges the surface to the per-layer expanded-byte budget", async () => {
    const result = await inspectLayers([buildTar([{ name: "app/a", content: "x" }])], { maxExpandedBytesPerLayer: 600 });
    expect(result.coverage.limitations).toContainEqual({ kind: "layer-byte-budget-exhausted", layer: 0 });
    expect(result.coverage.complete).toBe(false);
  });
});

/** A minimal STORED zip holding one file — a real container shape, built from the zip layout. */
function storedZip(name: string, body: Buffer): Buffer {
  const fileName = Buffer.from(name, "utf8");
  const crc = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(fileName.length, 28);
  const localLength = local.length + fileName.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(localLength, 16);
  return Buffer.concat([local, fileName, body, central, fileName, end]);
}

/**
 * F1 — a NON-ZERO TRAILER is bytes no member interpretation decoded. Staged as opaque surface, it was
 * reported as complete coverage while a gzip stream, a ZIP or a whole second tar sat there unexpanded
 * (the review's three witnesses). It is now also a recorded `archive-trailer-nonzero` gap that blocks,
 * at the layer AND inside nested tars. Zero-only padding after the marker stays complete.
 */
describe("a non-zero trailer fails closed at every level (F1)", () => {
  const valid = () => Buffer.concat([member({ name: "app/a" }, Buffer.from("x")), END]);
  const trailers: [string, (marker: string) => Buffer][] = [
    ["a gzip stream", (marker) => gzipSync(Buffer.from(`TOKEN=${marker}\n`))],
    ["a ZIP archive", (marker) => storedZip("secret.txt", Buffer.from(`TOKEN=${marker}\n`))],
    ["a second tar holding a gzipped member", (marker) => buildTar([{ name: "app/extra.gz", content: gzipSync(Buffer.from(`TOKEN=${marker}\n`)) }])],
  ];

  for (const [label, trailer] of trailers) {
    it(`records a layer trailer that is ${label} as a blocking gap, with identity still verified`, async () => {
      const marker = syntheticSecret();
      const result = await inspectLayers([Buffer.concat([valid(), trailer(marker)])]);
      expect(result.identityVerified).toBe(true);
      expect(result.coverage.limitations).toContainEqual({ kind: "archive-trailer-nonzero", layer: 0 });
      expect(result.coverage.complete).toBe(false);
      expectNotPublished(result, marker);
    });
  }

  it("keeps zero-only padding after the marker COMPLETE — no false positive on real layers", async () => {
    const result = await inspectLayers([Buffer.concat([valid(), Buffer.alloc(8 * BLOCK, 0)])]);
    expect(result.coverage.limitations).toEqual([]);
    expect(result.coverage.complete).toBe(true);
  });

  it("records a trailer inside a gzip-decoded nested tar, at its depth", async () => {
    const inner = Buffer.concat([member({ name: "fixture/a.txt" }, Buffer.from("inner")), END, gzipSync(Buffer.from(`TOKEN=${syntheticSecret()}`))]);
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tgz", content: gzipSync(inner) }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "archive-trailer-nonzero", layer: 0, depth: 1 });
    expect(result.coverage.complete).toBe(false);
  });

  it("records a trailer inside an UNCOMPRESSED nested tar too — scanned as member bytes, never decoded", async () => {
    const inner = Buffer.concat([member({ name: "fixture/a.txt" }, Buffer.from("inner")), END, storedZip("s.txt", Buffer.from("x"))]);
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tar", content: inner }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "archive-trailer-nonzero", layer: 0, depth: 1 });
    expect(result.coverage.complete).toBe(false);
  });
});

/**
 * F2 — an EMPTY PAX path hid a real `/app` file from the provenance inventory: `pax.path ?? ustar`
 * took `""`, while a POSIX extractor ignores the empty value and writes the ustar name. Refused.
 */
describe("an empty extended name is refused, not taken as the member's name (F2)", () => {
  it("refuses a correctly hashed layer whose PAX `path=` is empty before a real /app member", async () => {
    const layer = Buffer.concat([member({ name: "PaxHeader/p", typeflag: "x" }, Buffer.from("8 path=\n")), member({ name: "app/planted.js" }, Buffer.from("x")), END]);
    await expect(inspectLayers([layer])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
  });

  it("refuses an empty PAX `linkpath=` the same way — through the EMPTY branch, not a framing error", async () => {
    // 13 bytes: "13" + " " + "linkpath=" + "\n". (A 12-byte fixture was misframed and refused for the
    // wrong reason, so it never reached the empty-value check it was meant to test.)
    const record = Buffer.from("13 linkpath=\n");
    expect(record.length).toBe(13);
    const layer = Buffer.concat([member({ name: "PaxHeader/p", typeflag: "x" }, record), header({ name: "app/sym", typeflag: "2", linkname: "real" }), END]);
    const refusal = inspectLayers([layer]);
    await expect(refusal).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
    await expect(refusal).rejects.toThrow(/linkpath value is empty/);
  });

  it("refuses a PAX `path` that is only a NUL — non-empty, and still not a name", async () => {
    const layer = Buffer.concat([member({ name: "PaxHeader/p", typeflag: "x" }, Buffer.from("9 path=\0\n")), member({ name: "app/planted.js" }, Buffer.from("x")), END]);
    const refusal = inspectLayers([layer]);
    await expect(refusal).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
    await expect(refusal).rejects.toThrow(/NUL byte/);
  });
});

/**
 * NESTED EMPTY AND DECLARED TARS. The canonical empty tar is 1,024 zero bytes with no ustar magic, so a
 * nested `app/empty.tar` (or its gzip) was an "ordinary file" and anything appended after its end blocks
 * was staged opaque under complete coverage. One shared tar-candidate predicate now decides for the raw
 * member, the gzip-decoded payload and every recursive level; an explicit tar name must parse as a tar.
 */
describe("nested empty and declared tars are parsed, and their trailers block (AC-AUDIT-02/03)", () => {
  const trailerKinds: [string, (marker: string) => Buffer][] = [
    ["a gzip stream", (marker) => gzipSync(Buffer.from(`TOKEN=${marker}\n`))],
    ["a ZIP archive", (marker) => storedZip("secret.txt", Buffer.from(`TOKEN=${marker}\n`))],
    ["a second tar holding a gzipped member", (marker) => buildTar([{ name: "fixture/x.gz", content: gzipSync(Buffer.from(`TOKEN=${marker}\n`)) }])],
  ];
  const emptyWith = (trailer: Buffer) => Buffer.concat([END, trailer]);
  const containers: [string, (inner: Buffer) => Buffer, Partial<typeof AUDIT_LIMITS>, number][] = [
    ["raw app/empty.tar", (inner) => buildTar([{ name: "app/empty.tar", content: inner }]), {}, 1],
    ["raw EXTENSIONLESS app/data (recognised by its zero blocks, not its name)", (inner) => buildTar([{ name: "app/data", content: inner }]), {}, 1],
    ["gzip app/empty.tgz", (inner) => buildTar([{ name: "app/empty.tgz", content: gzipSync(inner) }]), {}, 1],
    ["gzip app/empty.tar.gz", (inner) => buildTar([{ name: "app/empty.tar.gz", content: gzipSync(inner) }]), {}, 1],
    [
      "recursive: app/outer.tgz holding empty.tar",
      (inner) => buildTar([{ name: "app/outer.tgz", content: gzipSync(buildTar([{ name: "empty.tar", content: inner }])) }]),
      { maxNestedArchiveDepth: 2 },
      2,
    ],
  ];

  for (const [container, wrap, limits, depth] of containers) {
    for (const [kind, trailer] of trailerKinds) {
      it(`NEGATIVE: ${container} + ${kind} after its end blocks is a blocking gap at depth ${depth}`, async () => {
        const marker = syntheticSecret();
        const result = await inspectLayers([wrap(emptyWith(trailer(marker)))], limits);
        expect(result.identityVerified).toBe(true);
        expect(result.coverage.limitations).toContainEqual({ kind: "archive-trailer-nonzero", layer: 0, depth });
        expect(result.coverage.complete).toBe(false);
        expectNotPublished(result, marker);
      });
    }
    it(`POSITIVE: ${container} holding a zero-only empty tar is complete`, async () => {
      const result = await inspectLayers([wrap(emptyWith(Buffer.alloc(4 * BLOCK, 0)))], limits);
      expect(result.coverage.limitations).toEqual([]);
      expect(result.coverage.complete).toBe(true);
    });
  }

  it("POSITIVE: an ordinary .gz of plaintext still inflates, completely, onto the scan surface", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([buildTar([{ name: "app/notes.gz", content: gzipSync(Buffer.from(`NOTE=${marker}\n`)) }])]);
    expect(result.coverage.complete).toBe(true);
    expect(scanSurface(result.scanDir)).toContain(marker);
  });

  it("POSITIVE: a well-formed .tgz expands completely, its member on the scan surface", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tgz", content: gzipSync(buildTar([{ name: "fixture/a.txt", content: `A=${marker}` }])) }])]);
    expect(result.coverage.complete).toBe(true);
    expect(scanSurface(result.scanDir)).toContain(marker);
  });

  it("a DECLARED tar that is short or malformed is a nested gap, not an ordinary file", async () => {
    for (const [name, content] of [
      ["app/short.tar", Buffer.from("not a tar at all\n")],
      ["app/short.tgz", gzipSync(Buffer.from("not a tar either\n"))],
      ["app/short.tar.gz", gzipSync(Buffer.alloc(300, 0x41))],
    ] as const) {
      const result = await inspectLayers([buildTar([{ name, content }])]);
      expect(result.coverage.limitations, name).toContainEqual({ kind: "nested-archive-undecodable", layer: 0, reason: "TarFormatError", depth: 1 });
      expect(result.coverage.complete).toBe(false);
    }
  });
});

/**
 * EVERY UNSAFE NAME IS A GAP. An absolute, traversing, NUL-bearing or empty member name does not
 * start with the `/app` prefix the inventory compares, so it used to fall out of the comparison with
 * nothing recorded while an extractor might still write it. Content is staged and scanned as usual.
 */
describe("an unsafe member path never silently leaves the inventory", () => {
  it("records unsafe top-level names, and stages their content", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([buildTar([
      { name: "/app/absolute.js", content: `A=${marker}` },
      { name: "app/../escape.js", content: "x" },
      { name: "app/ok.js", content: "fine" },
    ])]);
    const unsafe = result.coverage.limitations.filter((limitation) => limitation.kind === "unsafe-member-path");
    expect(unsafe).toEqual([{ kind: "unsafe-member-path", layer: 0 }, { kind: "unsafe-member-path", layer: 0 }]);
    expect(result.coverage.complete).toBe(false);
    expect(scanSurface(result.scanDir)).toContain(marker);
    expectNotPublished(result, "absolute.js");
  });

  it("records an unsafe name inside a nested archive, at its depth", async () => {
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tgz", content: gzipSync(buildTar([{ name: "../outside.txt", content: "x" }])) }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "unsafe-member-path", layer: 0, depth: 1 });
    expect(result.coverage.complete).toBe(false);
  });

  it("records nothing for ordinary relative names", async () => {
    const result = await inspectLayers([buildTar([{ name: "app/a.js", content: "1" }, { name: "./app/b.js", content: "2" }])]);
    expect(result.coverage.limitations).toEqual([]);
  });
});

/**
 * B1 — a magic-less V7 tar the READER accepts is recognised too. With a recogniser that only knew the
 * ustar magic, a V7 tar under a non-tar name (raw, or gzipped as a plain `.gz`) holding a gzipped member
 * was an ordinary file: complete coverage, and the member's content on no scan surface.
 */
describe("a magic-less V7 tar is recognised wherever the reader would read it (B1)", () => {
  const v7Tar = (marker: string) => Buffer.concat([
    header({ name: "in/a.gz", size: gzipSync(Buffer.from(`TOKEN=${marker}\n`)).length, v7: true }),
    Buffer.concat([gzipSync(Buffer.from(`TOKEN=${marker}\n`)), Buffer.alloc(BLOCK, 0)]).subarray(0, Math.ceil(gzipSync(Buffer.from(`TOKEN=${marker}\n`)).length / BLOCK) * BLOCK),
    END,
  ]);
  const shapes: [string, (bytes: Buffer) => Buffer][] = [
    ["raw extensionless app/blob.dat", (bytes) => buildTar([{ name: "app/blob.dat", content: bytes }])],
    ["gzipped under a plain name app/blob.gz", (bytes) => buildTar([{ name: "app/blob.gz", content: gzipSync(bytes) }])],
  ];
  for (const [label, wrap] of shapes) {
    it(`${label}: blocks at the depth bound instead of reporting complete`, async () => {
      const marker = syntheticSecret();
      const bytes = v7Tar(marker);
      expect(bytes.subarray(257, 262).toString("latin1")).not.toBe("ustar");
      const result = await inspectLayers([wrap(bytes)]);
      expect(result.identityVerified).toBe(true);
      expect(result.coverage.limitations).toContainEqual({ kind: "nested-archive-depth-limit", layer: 0, depth: 2 });
      expect(result.coverage.complete).toBe(false);
    });
    it(`${label}: expands to the hidden gzip's plaintext when the depth allows`, async () => {
      const marker = syntheticSecret();
      const result = await inspectLayers([wrap(v7Tar(marker))], { maxNestedArchiveDepth: 3 });
      expect(result.coverage.limitations).toEqual([]);
      expect(scanSurface(result.scanDir)).toContain(marker);
    });
  }

  it("an ordinary text file is not a tar candidate", async () => {
    const result = await inspectLayers([buildTar([{ name: "app/readme.dat", content: "plain text, ".repeat(60) }])]);
    expect(result.coverage.limitations).toEqual([]);
    expect(result.coverage.complete).toBe(true);
  });
});

/**
 * B2 — the NAME the inventory compares is the canonical path, resolved after ustar/PAX/GNU, so the
 * inventory sees what an extractor writes. Each row is a correctly hashed layer.
 */
describe("the inventory compares canonical member paths, and refuses ambiguous ones (B2)", () => {
  const planted = () => member({ name: "app/planted.js" }, Buffer.from("x"));
  const appPaths = (result: Awaited<ReturnType<typeof inspectLayers>>) => result.appMembers.map((m) => m.path);

  for (const [label, layer] of [
    ["`././app/planted.js`", () => buildTar([{ name: "././app/planted.js", content: "x" }])],
    ["`.//app/planted.js`", () => buildTar([{ name: ".//app/planted.js", content: "x" }])],
    ["ustar prefix `.` with name `./app/planted.js`", () => Buffer.concat([member({ name: "./app/planted.js", prefix: "." }, Buffer.from("x")), END])],
    ["interior `app/./sub//../`-free dots: `app/.//planted.js`", () => buildTar([{ name: "app/.//planted.js", content: "x" }])],
    ["a PAX path `app/./planted.js`", () => Buffer.concat([member({ name: "PaxHeader/p", typeflag: "x" }, paxRecord("path", "app/./planted.js")), member({ name: "ignored" }, Buffer.from("x")), END])],
    ["a GNU long name `./app//planted.js`", () => Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("./app//planted.js\0")), member({ name: "ignored" }, Buffer.from("x")), END])],
  ] as const) {
    it(`ACCEPTS ${label} as app/planted.js in the inventory`, async () => {
      const result = await inspectLayers([layer()]);
      expect(appPaths(result)).toEqual(["app/planted.js"]);
      expect(result.coverage.limitations).toEqual([]);
    });
  }

  const refused: [string, () => Buffer][] = [
    ["x{path=decoy}, x{comment}, then ustar app/planted.js", () => Buffer.concat([member({ name: "PaxHeader/a", typeflag: "x" }, paxRecord("path", "decoy")), member({ name: "PaxHeader/b", typeflag: "x" }, paxRecord("comment", "c")), planted(), END])],
    ["x{path=decoy}, g{comment}, then ustar app/planted.js", () => Buffer.concat([member({ name: "PaxHeader/a", typeflag: "x" }, paxRecord("path", "decoy")), member({ name: "PaxHeader/g", typeflag: "g" }, paxRecord("comment", "c")), planted(), END])],
    ["GNU L app/planted.js then x{path=decoy}", () => Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/planted.js\0")), member({ name: "PaxHeader/a", typeflag: "x" }, paxRecord("path", "decoy")), member({ name: "short" }, Buffer.from("x")), END])],
    ["x{path=decoy} then GNU L app/planted.js", () => Buffer.concat([member({ name: "PaxHeader/a", typeflag: "x" }, paxRecord("path", "decoy")), member({ name: "././@LongLink", typeflag: "L" }, Buffer.from("app/planted.js\0")), member({ name: "short" }, Buffer.from("x")), END])],
    ["GNU.sparse.name=app/planted.js", () => Buffer.concat([member({ name: "PaxHeader/s", typeflag: "x" }, Buffer.concat([paxRecord("GNU.sparse.major", "1"), paxRecord("GNU.sparse.minor", "0"), paxRecord("GNU.sparse.name", "app/planted.js")])), member({ name: "other" }, Buffer.from("x")), END])],
  ];
  for (const [label, layer] of refused) {
    it(`REFUSES the run for ${label}`, async () => {
      await expect(inspectLayers([layer()])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
    });
  }

  it("records host-dependent names as unsafe gaps: a file with a trailing slash, a backslash, a drive", async () => {
    const result = await inspectLayers([buildTar([
      { name: "app/x.js/", content: "a" },
      { name: "app\\y.js", content: "b" },
      { name: "C:/z.js", content: "c" },
      { name: "app/ok.js", content: "d" },
    ])]);
    expect(result.coverage.limitations.filter((l) => l.kind === "unsafe-member-path")).toHaveLength(3);
    expect(result.coverage.complete).toBe(false);
    expect(appPaths(result)).toContain("app/ok.js");
  });

  it("normalises before the MERGE: a dotted overwrite replaces, and a dotted whiteout deletes", async () => {
    const result = await inspectLayers([
      buildTar([{ name: "app/x.js", content: "first" }, { name: "app/gone.js", content: "doomed" }]),
      buildTar([{ name: ".//app/./x.js", content: "second" }, { name: "./app/./.wh.gone.js", content: "" }]),
    ]);
    expect(result.merged.visible.get("app/x.js")).toBe(1);
    expect(result.merged.visible.has("app/gone.js")).toBe(false);
    expect(result.merged.shadowed).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "app/x.js", layer: 0, removedBy: 1, reason: "overwritten" }),
      expect.objectContaining({ path: "app/gone.js", layer: 0, removedBy: 1, reason: "deleted" }),
    ]));
  });
});

/**
 * L1 (Astra adjudication) — a DECLARED tar holding gzipped plaintext is a nested gap that blocks.
 * Its inflated bytes are not staged (no whole decoded-tar doubling), so nothing here claims the marker
 * was scanned: the record says the content was not decoded, which is what blocks.
 */
describe("L1: a .tgz holding gzipped plaintext is undecodable and blocks", () => {
  it("records nested-archive-undecodable, incomplete coverage and a blocked readiness", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([buildTar([{ name: "app/notes.tgz", content: gzipSync(Buffer.from(`NOTE=${marker}\n`)) }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "nested-archive-undecodable", layer: 0, reason: "TarFormatError", depth: 1 });
    expect(result.coverage.complete).toBe(false);
    const readiness = transitionReadiness({
      coverage: result.coverage,
      inventory: { complete: true, findings: 0, counts: { missing: 0 } },
      findings: { total: 0, rules: 0, groups: [] },
      packageInventory: { status: "verified", otherVersions: 0 },
      identityVerified: true,
      recipe: { assertions: [{ id: "workflow.no-secret-refs", status: "satisfied" }] },
    });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/nested-archive-undecodable/);
    expectNotPublished(result, marker);
  });
});

/**
 * B3 — only a POSIX ustar header has a name prefix. Applying bytes 345–500 as one for V7 or GNU named
 * `app/planted.js` as `decoy/app/planted.js` (or `00000000001/app/planted.js`): outside `/app`, so the
 * file silently left the inventory under complete coverage while the runtime wrote it inside `/app`.
 */
describe("the header format decides the name prefix (B3)", () => {
  it("REFUSES a V7 planted file whose unused bytes would have renamed it", async () => {
    const layer = Buffer.concat([member({ name: "app/planted.js", v7: true, region: Buffer.from("decoy") }, Buffer.from("x")), END]);
    await expect(inspectLayers([layer])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
  });

  it("REFUSES a GNU planted file carrying an atime where POSIX keeps its prefix", async () => {
    const layer = Buffer.concat([member({ name: "app/planted.js", gnu: true, region: Buffer.from("00000000001\0") }, Buffer.from("x")), END]);
    await expect(inspectLayers([layer])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
  });

  for (const [label, spec] of [
    ["POSIX ustar prefix `app` + name `ok.js`", { name: "ok.js", prefix: "app" }],
    ["GNU with a zero region", { name: "app/ok.js", gnu: true }],
    ["V7 with a zero region", { name: "app/ok.js", v7: true }],
  ] as const) {
    it(`CONTROL: ${label} is inventoried as app/ok.js`, async () => {
      const result = await inspectLayers([Buffer.concat([member(spec, Buffer.from("x")), END])]);
      expect(result.appMembers.map((m) => m.path)).toEqual(["app/ok.js"]);
      expect(result.coverage.complete).toBe(true);
    });
  }
});

/** B4 — a LEADING-NUL size is the real size, never 0 with the body parsed as a phantom member. */
describe("a leading-NUL size field reads its real value (B4)", () => {
  it("inventories ONE member with the full 512-byte body and no phantom", async () => {
    const body = header({ name: "tmp/decoy" });
    const planted = header({ name: "app/empty.txt", size: 0 });
    Buffer.concat([Buffer.from([0]), Buffer.from("0000001000", "ascii"), Buffer.from([0])]).copy(planted, 124);
    planted.write("        ", 148, "ascii");
    let sum = 0;
    for (const byte of planted) sum += byte;
    planted.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const result = await inspectLayers([Buffer.concat([planted, body, END])]);
    expect(result.appMembers).toHaveLength(1);
    expect(result.appMembers[0]).toMatchObject({ path: "app/empty.txt", sha256: createHash("sha256").update(body).digest("hex") });
    expect([...result.merged.visible.keys()]).not.toContain("tmp/decoy");
    expect(result.coverage.members).toBe(1);
  });
});

/**
 * I1 — a directory whiteout removes the directory, its trailing-slash spelling and everything beneath
 * it on a segment boundary; a layer's whiteouts apply before its own entries.
 */
describe("directory whiteouts delete the whole subtree, and same-layer recreates survive (I1)", () => {
  const visible = (result: Awaited<ReturnType<typeof inspectLayers>>) => [...result.merged.visible.keys()].sort();

  it("an expected file under a deleted directory becomes MISSING, and readiness blocks", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([
      buildTar([{ name: "app/d/", type: "directory" }, { name: "app/d/x.js", content: `X=${marker}` }, { name: "app/keep.js", content: "k" }]),
      buildTar([{ name: "app/.wh.d", content: "" }]),
    ]);
    const expected = expectedInventory([
      { path: "d/x.js", type: "file", sha256: createHash("sha256").update(`X=${marker}`).digest("hex") },
      { path: "keep.js", type: "file", sha256: createHash("sha256").update("k").digest("hex") },
    ], "");
    const inventory = inventorySummary(compareInventory(latestAppMembers(result.appMembers, result.merged), expected));
    expect(inventory.counts.missing).toBe(1);
    expect(inventory.complete).toBe(false);
    const readiness = transitionReadiness({
      coverage: result.coverage, inventory, findings: { total: 0, rules: 0, groups: [] },
      packageInventory: { status: "verified", otherVersions: 0 }, identityVerified: true,
      recipe: { assertions: [{ id: "workflow.no-secret-refs", status: "satisfied" }] },
    });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/inventory comparison is incomplete/);
    // The deleted layer's bytes are STILL scanned.
    expect(scanSurface(result.scanDir)).toContain(marker);
  });

  for (const whiteout of ["app/.wh.d", "./app/./.wh.d", ".//app//.wh.d"]) {
    it(`\`${whiteout}\` removes app/d, app/d/ and every descendant, and keeps siblings sharing the prefix`, async () => {
      const result = await inspectLayers([
        buildTar([
          { name: "app/d", type: "directory" },
          { name: "app/d/x.js", content: "1" },
          { name: "app/d/sub/y.js", content: "2" },
          { name: "app/different/z.js", content: "3" },
          { name: "app/d2.js", content: "4" },
        ]),
        buildTar([{ name: whiteout, content: "" }]),
      ]);
      expect(visible(result)).toEqual(["app/d2.js", "app/different/z.js"]);
    });
  }

  it("a directory keyed with its trailing slash is removed too", () => {
    const merged = mergedFilesystem([["app/d/", "app/d/x.js", "app/dx"], ["app/.wh.d"]]);
    expect([...merged.visible.keys()]).toEqual(["app/dx"]);
  });

  it("a FILE whiteout still removes exactly that file", async () => {
    const result = await inspectLayers([
      buildTar([{ name: "app/f.js", content: "1" }, { name: "app/f.js.bak", content: "2" }]),
      buildTar([{ name: "app/.wh.f.js", content: "" }]),
    ]);
    expect(visible(result)).toEqual(["app/f.js.bak"]);
  });

  for (const order of ["whiteout first", "recreate first"] as const) {
    it(`a same-layer recreate survives its own whiteout (${order})`, async () => {
      const whiteout = { name: "app/.wh.d", content: "" };
      const recreate = { name: "app/d/new.js", content: "new" };
      const result = await inspectLayers([
        buildTar([{ name: "app/d/old.js", content: "old" }]),
        buildTar(order === "whiteout first" ? [whiteout, recreate] : [recreate, whiteout]),
      ]);
      expect(visible(result)).toEqual(["app/d/new.js"]);
      expect(result.merged.visible.get("app/d/new.js")).toBe(1);
    });
  }

  it("CONTROL: an opaque directory clears lower children and keeps its own layer's", async () => {
    const result = await inspectLayers([
      buildTar([{ name: "app/d/", type: "directory" }, { name: "app/d/old.js", content: "old" }, { name: "app/other.js", content: "o" }]),
      buildTar([{ name: "app/d/keep.js", content: "keep" }, { name: "app/d/.wh..wh..opq", content: "" }]),
    ]);
    expect(visible(result)).toEqual(["app/d/", "app/d/keep.js", "app/other.js"]);
  });
});

/**
 * L5 — a backslash in a member name stays REFUSED as unsafe: a deliberate, conservative compatibility
 * limitation (backslash is a legal Linux filename byte). It is recorded, and it blocks.
 */
describe("L5: a backslash name is an unsafe gap that blocks readiness", () => {
  it("records unsafe-member-path, incomplete coverage and a blocked transition", async () => {
    const result = await inspectLayers([buildTar([{ name: "usr/lib/system-systemd\\x2dcryptsetup.slice", content: "u" }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "unsafe-member-path", layer: 0 });
    expect(result.coverage.complete).toBe(false);
    const readiness = transitionReadiness({
      coverage: result.coverage, inventory: { complete: true, findings: 0, counts: { missing: 0 } },
      findings: { total: 0, rules: 0, groups: [] }, packageInventory: { status: "verified", otherVersions: 0 },
      identityVerified: true, recipe: { assertions: [{ id: "workflow.no-secret-refs", status: "satisfied" }] },
    });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/unsafe-member-path/);
  });
});

describe("structural failure refuses, whatever the identity chain says (AC-AUDIT-03)", () => {
  it("refuses a correctly hashed SHORT non-tar layer at representative lengths", async () => {
    for (const length of [1, 100, 262, 511]) {
      const marker = syntheticSecret();
      const bytes = Buffer.concat([Buffer.from(marker), Buffer.alloc(BLOCK, 0x20)]).subarray(0, length);
      await expect(inspectLayers([bytes]), `length ${length}`).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
    }
  });

  it("refuses a zero-length layer", async () => {
    await expect(inspectLayers([Buffer.alloc(0)])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
  });

  it("refuses a layer with a header-only member whose declared body conceals another member", async () => {
    const concealed = member({ name: "app/hidden.txt" }, Buffer.from(`TOKEN=${syntheticSecret()}\n`));
    const layer = Buffer.concat([header({ name: "app/link", typeflag: "2", linkname: "x", size: concealed.length }), concealed, END]);
    await expect(inspectLayers([layer])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
  });

  it("refuses a layer without its end-of-archive blocks, and one with a single end block", async () => {
    const body = member({ name: "app/a" }, Buffer.from("x"));
    await expect(inspectLayers([body])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
    await expect(inspectLayers([Buffer.concat([body, Buffer.alloc(BLOCK)])])).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
  });

  it("refuses an OUTER export carrying non-zero bytes after its end blocks — it has no surface to scan them on", async () => {
    const image = synthesizeImage([buildTar([{ name: "app/a", content: "x" }])]);
    const dir = pool.make();
    const withTrailer = { ...image, exportTar: Buffer.concat([image.exportTar, Buffer.from(syntheticSecret())]) };
    await expect(inspectSynthetic(withTrailer, dir)).rejects.toMatchObject({ code: "AUDIT_TAR_STRUCTURE_INVALID" });
  });

  it("records a structurally broken NESTED tar as `nested-archive-undecodable`, which blocks", async () => {
    const inner = buildTar([{ name: "fixture/a.txt", content: "inner" }]);
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tgz", content: gzipSync(inner.subarray(0, inner.length - BLOCK)) }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "nested-archive-undecodable", layer: 0, reason: "TarFormatError", depth: 1 });
    expect(result.coverage.complete).toBe(false);
  });

  it("refuses a layer whose metadata exceeds the reviewed ceiling, with a fixed limit code", async () => {
    const layer = Buffer.concat([member({ name: "././@LongLink", typeflag: "L" }, Buffer.alloc(4096, 0x61)), member({ name: "app/a" }, Buffer.from("x")), END]);
    await expect(inspectLayers([layer], { maxTarMetadataRecordBytes: 1024 })).rejects.toMatchObject({ code: "AUDIT_TAR_LIMIT_EXCEEDED" });
  });
});

describe("expiry and partial output go through the production error path (AC-AUDIT-04)", () => {
  const expiring = (operation: string) => ({
    assert(asked: string) {
      if (asked === operation) throw Object.assign(new Error("deadline"), { code: "STAGING_OPERATION_TIMEOUT" });
    },
  });

  function layerOnDisk(tar: Buffer) {
    const dir = pool.make();
    const layerTarPath = join(dir, "layer.tar");
    writeFileSync(layerTarPath, tar);
    return { dir, layerTarPath, scanDir: join(dir, "scan") };
  }

  it("removes the PARTIAL member file when its content emitter throws mid-stream", () => {
    const { layerTarPath, scanDir } = layerOnDisk(buildTar([{ name: "app/big", content: Buffer.alloc(4096, 0x61) }]));
    expect(() => inventoryLayer({
      layerTarPath, layerIndex: 0, scanDir, limits: AUDIT_LIMITS,
      stagingBudget: createStagingBudget(),
      deadline: expiring("tar member content"),
      readerTuning: { chunkBytes: 256, deadlineEveryBytes: 1024 },
    })).toThrow(/deadline/);
    // Only the complete surface file of the header remains; no truncated member copy.
    expect(readdirSync(join(scanDir, "L0"))).toEqual(["M"]);
  });

  it("removes the PARTIAL surface file when surface staging expires mid-range", () => {
    const { layerTarPath, scanDir } = layerOnDisk(Buffer.concat([buildTar([{ name: "app/a", content: "x" }]), Buffer.alloc(8192, 0x62)]));
    expect(() => inventoryLayer({
      layerTarPath, layerIndex: 0, scanDir, limits: AUDIT_LIMITS,
      stagingBudget: createStagingBudget(),
      deadline: expiring("archive surface staging"),
      readerTuning: { chunkBytes: 512, deadlineEveryBytes: 2048 },
    })).toThrow(/deadline/);
    const surface = readdirSync(join(scanDir, archiveSurfaceGroup(0)));
    // Whatever was left is whole — no file holds a truncated copy of the trailer range.
    for (const entry of surface) {
      expect(readFileSync(join(scanDir, archiveSurfaceGroup(0), entry)).includes(Buffer.alloc(64, 0x62))).toBe(false);
    }
  });

  it("F8: falls back to the REVIEWED surface-file bound, never to unbounded, when limits omit it", () => {
    const { maxArchiveSurfaceFileBytes: _omitted, ...limits } = AUDIT_LIMITS;
    const body = Buffer.alloc(AUDIT_LIMITS.maxArchiveSurfaceFileBytes + BLOCK, 0x2e);
    const { layerTarPath, scanDir } = layerOnDisk(Buffer.concat([member({ name: "app/odd", typeflag: "M" }, body), END]));
    const result = inventoryLayer({ layerTarPath, layerIndex: 0, scanDir, limits: limits as typeof AUDIT_LIMITS, stagingBudget: createStagingBudget() });
    expect(result.limitations).toContainEqual({ kind: "archive-surface-range-unstageable", layer: 0 });
  });

  it("consults the clock while staging content, not only between members", () => {
    const { layerTarPath, scanDir } = layerOnDisk(buildTar([{ name: "app/big", content: Buffer.alloc(4096, 0x61) }]));
    const asked: string[] = [];
    inventoryLayer({
      layerTarPath, layerIndex: 0, scanDir, limits: AUDIT_LIMITS,
      stagingBudget: createStagingBudget(),
      deadline: { assert: (operation: string) => { asked.push(operation); } },
      readerTuning: { chunkBytes: 256, deadlineEveryBytes: 1024 },
    });
    expect(asked.filter((operation) => operation === "tar member content").length).toBeGreaterThanOrEqual(3);
  });
});
