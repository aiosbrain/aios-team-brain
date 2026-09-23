import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { AUDIT_LIMITS } from "../scripts/staging-ops/image-audit/subject.mjs";
import { createStagingBudget, inventoryLayer } from "../scripts/staging-ops/image-audit/export-walk.mjs";
import { createRetainedStateBudget, createWorkBudget } from "../scripts/staging-ops/image-audit/budgets.mjs";
import { SCAN_HEADER, archiveSurfaceGroup } from "../scripts/staging-ops/image-audit/scan-surface.mjs";
import { transitionReadiness } from "../scripts/staging-ops/image-audit/evidence.mjs";
import { compareInventory, expectedInventory, inventorySummary } from "../scripts/staging-ops/image-audit/expected-tree.mjs";
import { latestAppMembers } from "../scripts/staging-ops/image-audit/inspect.mjs";
import { mergedFilesystem } from "../scripts/staging-ops/image-audit/layers.mjs";
import { buildTar, syntheticSecret } from "./helpers/tar-fixture";
import { inspectSynthetic, memberScanFiles, scanFiles as scanFilesUnder, scanSurface, scratchPool, surfaceScanFiles, synthesizeImage } from "./helpers/synthetic-image";

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
    /**
     * SUPERSEDED (B8). This used to assert the recreate simply "survives" in both orders. OCI says a
     * whiteout applies only below its layer; containerd v2.1.4 removes the entry when the whiteout
     * follows it. The merge still ACCOUNTS lower-only, and now also records the disagreement as a gap.
     */
    it(`a same-layer recreate under its own whiteout is accounted lower-only AND recorded as a conflict (${order})`, async () => {
      const whiteout = { name: "app/.wh.d", content: "" };
      const recreate = { name: "app/d/new.js", content: "new" };
      const result = await inspectLayers([
        buildTar([{ name: "app/d/old.js", content: "old" }]),
        buildTar(order === "whiteout first" ? [whiteout, recreate] : [recreate, whiteout]),
      ]);
      expect(visible(result)).toEqual(["app/d/new.js"]);
      expect(result.merged.visible.get("app/d/new.js")).toBe(1);
      expect(result.coverage.limitations).toContainEqual({ kind: "merged-type-conflict", layer: 1 });
      expect(result.coverage.complete).toBe(false);
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

/**
 * B5/B6 — the MERGED NAMESPACE, measured end to end: correctly hashed image → inspector → merged view
 * → inventory → readiness. The base layer ships `app/index.js` and `app/d/x.js`, both expected.
 */
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const EXPECTED_BASE = [
  { path: "index.js", type: "file", sha256: sha("index") },
  { path: "d/x.js", type: "file", sha256: sha("x") },
];
const baseMembers = [
  { name: "app/", type: "directory" as const },
  { name: "app/index.js", content: "index" },
  { name: "app/d/", type: "directory" as const },
  { name: "app/d/x.js", content: "x" },
];
function chain(result: Awaited<ReturnType<typeof inspectLayers>>, expectedEntries: { path: string; type: string; sha256: string }[] = EXPECTED_BASE) {
  const inventory = inventorySummary(compareInventory(latestAppMembers(result.appMembers, result.merged), expectedInventory(expectedEntries, "")));
  const readiness = transitionReadiness({
    coverage: result.coverage, inventory, findings: { total: 0, rules: 0, groups: [] },
    packageInventory: { status: "verified", otherVersions: 0 }, identityVerified: true,
    recipe: { assertions: [{ id: "workflow.no-secret-refs", status: "satisfied" }] },
  });
  return { inventory, readiness, kinds: result.coverage.limitations.map((l) => l.kind) };
}

describe("a member written through a symlinked parent is a blocking gap (B5)", () => {
  it("CONTROL: the base image alone is ready", async () => {
    const { readiness } = chain(await inspectLayers([buildTar(baseMembers)]));
    expect(readiness.transitionReady).toBe(true);
  });

  it("same layer: `side -> app` then `side/planted.js` blocks, and the bytes are still scanned", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([buildTar([...baseMembers, { name: "side", type: "symlink", linkTarget: "app" }, { name: "side/planted.js", content: `P=${marker}` }])]);
    const { readiness, kinds } = chain(result);
    expect(result.coverage.limitations).toContainEqual({ kind: "member-through-symlink", layer: 0 });
    expect(kinds).toContain("member-through-symlink");
    expect(readiness.transitionReady).toBe(false);
    expect(scanSurface(result.scanDir)).toContain(marker);
    expectNotPublished(result, "side/planted.js");
  });

  it("prior layer: `side -> /app`, then an upper `side/d/x.js` overwrite blocks at the upper layer", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([
      buildTar([...baseMembers, { name: "side", type: "symlink", linkTarget: "/app" }]),
      buildTar([{ name: "side/d/", type: "directory" }, { name: "side/d/x.js", content: `EVIL=${marker}` }]),
    ]);
    const { readiness } = chain(result);
    expect(result.coverage.limitations).toContainEqual({ kind: "member-through-symlink", layer: 1 });
    expect(readiness.transitionReady).toBe(false);
    expect(scanSurface(result.scanDir)).toContain(marker);
  });

  it("same layer, REVERSE order (member before its link) still blocks — conservative", async () => {
    const result = await inspectLayers([buildTar([...baseMembers, { name: "side/planted.js", content: "p" }, { name: "side", type: "symlink", linkTarget: "app" }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "member-through-symlink", layer: 0 });
    expect(chain(result).readiness.transitionReady).toBe(false);
  });

  it("a link replaced later still counts (historical union)", async () => {
    const result = await inspectLayers([
      buildTar([...baseMembers, { name: "side", type: "symlink", linkTarget: "app" }]),
      buildTar([{ name: ".wh.side", content: "" }]),
      buildTar([{ name: "side/later.js", content: "l" }]),
    ]);
    expect(result.coverage.limitations).toContainEqual({ kind: "member-through-symlink", layer: 2 });
  });

  it("an UNUSED external symlink leaves a normal /app ready", async () => {
    const { readiness, kinds } = chain(await inspectLayers([buildTar([...baseMembers, { name: "usr/bin/", type: "directory" }, { name: "usr/bin/sh", type: "symlink", linkTarget: "busybox" }, { name: "bin", type: "symlink", linkTarget: "usr/bin" }, { name: "usr/bin/busybox", content: "b" }])]));
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(true);
  });

  it("a sibling `side2` is NOT beneath `side`", async () => {
    const { readiness, kinds } = chain(await inspectLayers([buildTar([...baseMembers, { name: "side", type: "symlink", linkTarget: "app" }, { name: "side2/file.js", content: "s" }])]));
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(true);
  });

  it("the existing symlink-INSIDE-app finding is kept", async () => {
    const result = await inspectLayers([buildTar([...baseMembers, { name: "app/d2", type: "symlink", linkTarget: "." }])]);
    const { inventory, readiness, kinds } = chain(result);
    expect(kinds).not.toContain("member-through-symlink");
    expect(inventory.findings).toBeGreaterThan(0);
    expect(readiness.transitionReady).toBe(false);
  });
});

describe("type replacement and malformed whiteouts in the merged view (B6)", () => {
  it("a directory's key is type-driven: `app/d` and `app/d/` written as directories are one key", async () => {
    const result = await inspectLayers([buildTar([{ name: "app/d", type: "directory" }]), buildTar([{ name: "app/d/", type: "directory" }])]);
    expect([...result.merged.visible.keys()]).toEqual(["app/d/"]);
  });

  it("`app/` replaced by a regular FILE `app`: every expected file is missing, root gap recorded, blocked", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([buildTar([...baseMembers.slice(0, 3), { name: "app/d/x.js", content: "x" }, { name: "app/secret.js", content: `S=${marker}` }]), buildTar([{ name: "app", content: "EVIL" }])]);
    const { inventory, readiness, kinds } = chain(result);
    expect(inventory.counts.missing).toBe(2);
    expect(kinds).toContain("inventory-root-not-directory");
    expect(readiness.transitionReady).toBe(false);
    expect(result.merged.shadowed).toContainEqual(expect.objectContaining({ path: "app/index.js", reason: "replaced-by-non-directory" }));
    // The replaced lower bytes are still staged.
    expect(scanSurface(result.scanDir)).toContain(marker);
  });

  it("`app/` replaced by a SYMLINK `app -> decoy`: missing, root gap, blocked", async () => {
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "decoy/", type: "directory" }, { name: "decoy/index.js", content: "EVIL" }, { name: "app", type: "symlink", linkTarget: "decoy" }])]);
    const { inventory, readiness, kinds } = chain(result);
    expect(inventory.counts.missing).toBe(2);
    expect(kinds).toContain("inventory-root-not-directory");
    expect(readiness.transitionReady).toBe(false);
  });

  it("a nested directory `app/d/` replaced by a file `app/d`: its descendant is missing, blocked", async () => {
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "app/d", content: "now a file" }])]);
    const { inventory, readiness } = chain(result);
    expect(inventory.counts.missing).toBe(1);
    expect(result.merged.shadowed).toContainEqual(expect.objectContaining({ path: "app/d/x.js", reason: "replaced-by-non-directory" }));
    expect(readiness.transitionReady).toBe(false);
  });

  it("INVERSE: a file `app/cfg` replaced by a directory `app/cfg/`: the expected file is missing, blocked", async () => {
    const expected = [...EXPECTED_BASE, { path: "cfg", type: "file", sha256: sha("cfg") }];
    const result = await inspectLayers([buildTar([...baseMembers, { name: "app/cfg", content: "cfg" }]), buildTar([{ name: "app/cfg/", type: "directory" }])]);
    const { inventory, readiness } = chain(result, expected);
    expect(inventory.counts.missing).toBe(1);
    expect(result.merged.shadowed).toContainEqual(expect.objectContaining({ path: "app/cfg", reason: "replaced-by-directory" }));
    expect(readiness.transitionReady).toBe(false);
  });

  for (const [label, marker] of [
    ["a DIRECTORY-typed `app/.wh.d/`", { name: "app/.wh.d/", type: "directory" as const }],
    ["a SYMLINK-typed `app/.wh.d`", { name: "app/.wh.d", type: "symlink" as const, linkTarget: "x" }],
    ["a NON-EMPTY regular `app/.wh.d`", { name: "app/.wh.d", content: "not empty" }],
  ] as const) {
    it(`${label} is applied as extractors would, AND recorded as malformed — blocked`, async () => {
      const result = await inspectLayers([buildTar(baseMembers), buildTar([marker])]);
      const { inventory, readiness, kinds } = chain(result);
      expect(inventory.counts.missing).toBe(1);
      expect(kinds).toContain("malformed-whiteout");
      expect(readiness.transitionReady).toBe(false);
    });
  }

  it("a same-layer file AND descendants of the same name are a merged-type-conflict", async () => {
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "app/z", content: "f" }, { name: "app/z/q.js", content: "q" }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "merged-type-conflict", layer: 1 });
    expect(chain(result).readiness.transitionReady).toBe(false);
  });

  it("writing beneath a LOWER non-directory is a merged-type-conflict", async () => {
    const result = await inspectLayers([buildTar([...baseMembers, { name: "app/f", content: "f" }]), buildTar([{ name: "app/f/inner.js", content: "i" }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "merged-type-conflict", layer: 1 });
  });

  it("POSITIVE: directory over directory MERGES", async () => {
    const expected = [...EXPECTED_BASE, { path: "d/y.js", type: "file", sha256: sha("y") }];
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "app/d/", type: "directory" }, { name: "app/d/y.js", content: "y" }])]);
    const { readiness, kinds } = chain(result, expected);
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(true);
  });

  it("POSITIVE: a valid EMPTY REGULAR whiteout removes only lower content and stays ready", async () => {
    const result = await inspectLayers([buildTar([...baseMembers, { name: "app/old.js", content: "o" }]), buildTar([{ name: "app/.wh.old.js", content: "" }])]);
    const { readiness, kinds } = chain(result);
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(true);
  });

  for (const order of ["whiteout first", "recreate first"] as const) {
    // SUPERSEDED (B8): this was a POSITIVE; a same-layer ordinary whiteout overlapping a recreated
    // directory is order-dependent across extractors, so it is now a blocking conflict in either order.
    it(`a same-layer delete overlapping a recreated directory BLOCKS (${order})`, async () => {
      const whiteout = { name: "app/.wh.d", content: "" };
      const recreate = [{ name: "app/d/", type: "directory" as const }, { name: "app/d/x.js", content: "x" }];
      const result = await inspectLayers([buildTar(baseMembers), buildTar(order === "whiteout first" ? [whiteout, ...recreate] : [...recreate, whiteout])]);
      const { readiness, kinds } = chain(result);
      expect(kinds).toEqual(["merged-type-conflict"]);
      expect(result.merged.visible.get("app/d/x.js")).toBe(1);
      expect(readiness.transitionReady).toBe(false);
    });
  }

  it("POSITIVE: an opaque directory keeps its own layer's entries and stays ready", async () => {
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "app/d/.wh..wh..opq", content: "" }, { name: "app/d/x.js", content: "x" }])]);
    const { readiness, kinds } = chain(result);
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(true);
  });
});

/** B7 — a ROOT opaque marker empties everything below it; its own layer's entries are then applied. */
describe("a root opaque whiteout empties the lower rootfs (B7)", () => {
  it("lower expected /app files become missing and readiness blocks; their bytes are still scanned", async () => {
    const marker = syntheticSecret();
    const result = await inspectLayers([buildTar([...baseMembers, { name: "app/secret.js", content: `S=${marker}` }]), buildTar([{ name: ".wh..wh..opq", content: "" }])]);
    const { inventory, readiness, kinds } = chain(result);
    expect(inventory.counts.missing).toBe(2);
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(false);
    expect([...result.merged.visible.keys()]).toEqual([]);
    expect(scanSurface(result.scanDir)).toContain(marker);
  });

  it("CONTROL: a root opaque plus a full same-layer recreation of /app is ready", async () => {
    const result = await inspectLayers([buildTar([...baseMembers, { name: "etc/old.conf", content: "o" }]), buildTar([{ name: ".wh..wh..opq", content: "" }, ...baseMembers])]);
    const { readiness, kinds } = chain(result);
    expect(kinds).toEqual([]);
    expect(result.merged.visible.has("etc/old.conf")).toBe(false);
    expect(readiness.transitionReady).toBe(true);
  });

  it("CONTROL: nested opacity preserves siblings outside its directory", async () => {
    const result = await inspectLayers([buildTar([...baseMembers, { name: "app/e/", type: "directory" }, { name: "app/e/y.js", content: "y" }]), buildTar([{ name: "app/e/.wh..wh..opq", content: "" }])]);
    expect(result.merged.visible.has("app/e/y.js")).toBe(false);
    expect(result.merged.visible.has("app/d/x.js")).toBe(true);
    expect(chain(result).readiness.transitionReady).toBe(true);
  });
});

/**
 * B8 — an ordinary whiteout overlapping an entry of its OWN layer. OCI applies it below only; containerd
 * v2.1.4 removes the entry when the whiteout follows it. Recorded as a conflict in either order.
 */
describe("a same-layer ordinary whiteout overlapping its own layer is a conflict (B8)", () => {
  const shapes: [string, () => { name: string; content?: string; type?: "directory" }[], { name: string; content: string }][] = [
    ["a FILE", () => [{ name: "app/index.js", content: "index" }], { name: "app/.wh.index.js", content: "" }],
    ["a DIRECTORY and its subtree", () => [{ name: "app/d/", type: "directory" }, { name: "app/d/x.js", content: "x" }], { name: "app/.wh.d", content: "" }],
    ["only a DESCENDANT (no directory entry)", () => [{ name: "app/d/x.js", content: "x" }], { name: "app/.wh.d", content: "" }],
  ];
  for (const [label, entries, whiteout] of shapes) {
    for (const order of ["entry first", "whiteout first"] as const) {
      it(`${label}, ${order}: merged-type-conflict and blocked`, async () => {
        const result = await inspectLayers([buildTar(baseMembers), buildTar(order === "entry first" ? [...entries(), whiteout] : [whiteout, ...entries()])]);
        expect(result.coverage.limitations).toContainEqual({ kind: "merged-type-conflict", layer: 1 });
        expect(chain(result).readiness.transitionReady).toBe(false);
      });
    }
  }

  it("POSITIVE: a similar-prefix SIBLING is not an overlap", async () => {
    // `app/.wh.old.js` beside a same-layer `app/old.js2` (and an unrelated `app/d2.js`): prefix-sharing
    // names that are not the whiteout's target, its directory spelling or a descendant.
    const expected = [...EXPECTED_BASE, { path: "d2.js", type: "file", sha256: sha("d2") }, { path: "old.js2", type: "file", sha256: sha("n") }];
    const result = await inspectLayers([
      buildTar([...baseMembers, { name: "app/old.js", content: "o" }]),
      buildTar([{ name: "app/.wh.old.js", content: "" }, { name: "app/old.js2", content: "n" }, { name: "app/d2.js", content: "d2" }]),
    ]);
    const { readiness, kinds } = chain(result, expected);
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(true);
  });

  it("POSITIVE: recreation in a LATER layer is ready", async () => {
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "app/.wh.d", content: "" }]), buildTar([{ name: "app/d/", type: "directory" }, { name: "app/d/x.js", content: "x" }])]);
    const { readiness, kinds } = chain(result);
    expect(kinds).toEqual([]);
    expect(result.merged.visible.get("app/d/x.js")).toBe(2);
    expect(readiness.transitionReady).toBe(true);
  });

  it("POSITIVE: an OPAQUE marker with a same-layer child is supported, not a conflict", async () => {
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "app/d/x.js", content: "x" }, { name: "app/d/.wh..wh..opq", content: "" }])]);
    const { readiness, kinds } = chain(result);
    expect(kinds).toEqual([]);
    expect(readiness.transitionReady).toBe(true);
  });
});

/** L6 — an ordinary whiteout naming nothing, `.` or `..` is malformed and deletes NOTHING. */
describe("empty, dot and dot-dot whiteout targets are malformed (L6)", () => {
  for (const name of [".wh.", ".wh..", ".wh...", "app/.wh.", "app/.wh..", "app/.wh...", "app/d/.wh.."]) {
    it(`\`${name}\` records malformed-whiteout and removes nothing`, async () => {
      const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name, content: "" }])]);
      const { inventory, readiness, kinds } = chain(result);
      expect(kinds).toEqual(["malformed-whiteout"]);
      expect(inventory.counts.missing).toBe(0);
      expect(result.merged.visible.has("app/d/x.js")).toBe(true);
      expect(readiness.transitionReady).toBe(false);
    });
  }

  it("CONTROL: a valid `.wh.name` at the root and nested still deletes, with no gap", async () => {
    const result = await inspectLayers([buildTar([...baseMembers, { name: "stale.txt", content: "s" }, { name: "app/d/old.js", content: "o" }]), buildTar([{ name: ".wh.stale.txt", content: "" }, { name: "app/d/.wh.old.js", content: "" }])]);
    const { readiness, kinds } = chain(result);
    expect(kinds).toEqual([]);
    expect(result.merged.visible.has("stale.txt")).toBe(false);
    expect(result.merged.visible.has("app/d/old.js")).toBe(false);
    expect(readiness.transitionReady).toBe(true);
  });
});

/** B9 — a deep member path refuses the run with the fixed limit code, before the merge or staging expands it. */
describe("a member path past the supported bound refuses the run (B9)", () => {
  it("a 250,000-segment PAX path in a correctly hashed layer is AUDIT_TAR_LIMIT_EXCEEDED", async () => {
    const layer = Buffer.concat([member({ name: "PaxHeader/deep", typeflag: "x" }, paxRecord("path", `${"a/".repeat(250_000)}x`)), member({ name: "short" }, Buffer.from("x")), END]);
    await expect(inspectLayers([layer])).rejects.toMatchObject({ code: "AUDIT_TAR_LIMIT_EXCEEDED" });
  });

  it("CONTROL: a 128-segment path at the bound is inventoried", async () => {
    const path = `app/${Array.from({ length: 127 }, (_, i) => `s${i}`).join("/")}`;
    const result = await inspectLayers([buildTar([{ name: path, content: "deep", paxLongName: true }])]);
    expect(result.appMembers.map((m) => m.path)).toEqual([path]);
  });
});

/**
 * B10 — an OPAQUE marker's position in the layer matters. The pinned runtime's overlay converter keeps a
 * same-layer descendant written before the marker; its non-overlay converter can remove one whose
 * intermediate directory was only created implicitly. The audit records the ambiguity rather than
 * choosing a runtime. The marker here targets `cache/`, OUTSIDE `/app`: no expected file is involved,
 * so an ELIGIBLE row stays ready and only the ambiguity moves the verdict.
 */
describe("opaque-marker ordering ambiguity (B10)", () => {
  const marker = { name: "cache/.wh..wh..opq", content: "" };
  const upper = (...members: { name: string; content?: string; type?: "directory" }[]) => [buildTar(baseMembers), buildTar(members)];

  const rows: [string, { name: string; content?: string; type?: "directory" }[], boolean][] = [
    ["an earlier deep descendant with an UNDECLARED intermediate", [{ name: "cache/sub/x.js", content: "x" }, marker], true],
    ["an earlier DIRECTORY descendant with an undeclared intermediate", [{ name: "cache/sub/deeper/", type: "directory" }, marker], true],
    ["a descendant missing ONE intermediate of a longer chain", [{ name: "cache/a/", type: "directory" }, { name: "cache/a/b/x.js", content: "x" }, marker], true],
    ["the intermediate declared AFTER the marker", [{ name: "cache/sub/x.js", content: "x" }, marker, { name: "cache/sub/", type: "directory" }], true],
    ["the marker FIRST", [marker, { name: "cache/sub/x.js", content: "x" }], false],
    ["an earlier DIRECT child", [{ name: "cache/x.js", content: "x" }, marker], false],
    ["the intermediate declared BEFORE its descendant", [{ name: "cache/sub/", type: "directory" }, { name: "cache/sub/x.js", content: "x" }, marker], false],
    ["the intermediate declared BETWEEN descendant and marker", [{ name: "cache/sub/x.js", content: "x" }, { name: "cache/sub/", type: "directory" }, marker], false],
    ["a complete chain declared earlier", [{ name: "cache/a/", type: "directory" }, { name: "cache/a/b/", type: "directory" }, { name: "cache/a/b/x.js", content: "x" }, marker], false],
    ["a segment-PREFIX sibling directory", [{ name: "cache2/sub/x.js", content: "x" }, marker], false],
    ["an unrelated nested sibling", [{ name: "other/sub/x.js", content: "x" }, marker], false],
  ];

  for (const [label, members, ambiguous] of rows) {
    it(`${ambiguous ? "BLOCKS" : "stays eligible"}: ${label}`, async () => {
      const result = await inspectLayers(upper(...members));
      const { readiness, kinds } = chain(result);
      if (ambiguous) {
        expect(result.coverage.limitations).toContainEqual({ kind: "merged-type-conflict", layer: 1 });
        expect(readiness.transitionReady).toBe(false);
      } else {
        expect(kinds).toEqual([]);
        expect(readiness.transitionReady).toBe(true);
      }
    });
  }

  it("the ambiguous layer's bytes are still on the scan surface", async () => {
    const secret = syntheticSecret();
    const result = await inspectLayers(upper({ name: "cache/sub/x.js", content: `K=${secret}` }, marker));
    expect(result.coverage.limitations).toContainEqual({ kind: "merged-type-conflict", layer: 1 });
    expect(scanSurface(result.scanDir)).toContain(secret);
    expectNotPublished(result, secret);
  });

  /**
   * THE ROOT MARKER IS NOT EXEMPT (round 9). An earlier entry that only created `app/` and `app/sub/`
   * implicitly is the same ambiguity one level up, so the ordering rule applies to `.wh..wh..opq` at the
   * root as well; B7's emptying of the layers below it is unchanged.
   */
  it("BLOCKS: a root marker after entries whose ancestor directories were never declared", async () => {
    const result = await inspectLayers([buildTar(baseMembers), buildTar([{ name: "app/sub/x.js", content: "x" }, { name: ".wh..wh..opq", content: "" }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "merged-type-conflict", layer: 1 });
    const { inventory, readiness } = chain(result);
    expect(inventory.counts.missing).toBe(2); // B7 still empties what is below the marker
    expect(readiness.transitionReady).toBe(false);
  });

  it("stays eligible: a root marker FIRST, and one whose directories are all declared before it", async () => {
    const markerFirst = await inspectLayers([buildTar(baseMembers), buildTar([{ name: ".wh..wh..opq", content: "" }, ...baseMembers])]);
    expect(markerFirst.coverage.limitations).toEqual([]);
    expect(chain(markerFirst).readiness.transitionReady).toBe(true);

    const declared = await inspectLayers([buildTar(baseMembers), buildTar([
      { name: "app/", type: "directory" }, { name: "app/index.js", content: "index" },
      { name: "app/d/", type: "directory" }, { name: "app/d/x.js", content: "x" },
      { name: ".wh..wh..opq", content: "" },
    ])]);
    expect(declared.coverage.limitations).toEqual([]);
    expect(chain(declared).readiness.transitionReady).toBe(true);
  });
});

/** B9-R at the INVENTORY boundary: a refusal happens before the allocation, and leaves no partial output. */
describe("the retained-state budget refuses inside a layer inventory (B9-R)", () => {
  it("charges each retained PATH itself — measured on DIRECTORIES, which are neither staged nor inventoried", () => {
    // A directory member has no staged file and no `/app` record, so the ONLY thing its name can cost
    // is the `paths` entry the merge later consumes. Long directory names must therefore cost more.
    const layerWith = (name: (i: number) => string) => {
      const dir = pool.make();
      const layerTarPath = join(dir, "layer.tar");
      writeFileSync(layerTarPath, buildTar(Array.from({ length: 10 }, (_, i) => ({ name: `${name(i)}/`, type: "directory" as const, paxLongName: true }))));
      const retained = createRetainedStateBudget();
      inventoryLayer({ layerTarPath, layerIndex: 0, scanDir: join(dir, "scan"), limits: AUDIT_LIMITS, stagingBudget: createStagingBudget(), retained });
      return retained.used;
    };
    const short = layerWith((i) => `app/s${i}`);
    const long = layerWith((i) => `app/${Array.from({ length: 8 }, (_, part) => `d${part}${"n".repeat(70)}`).join("/")}/${i}`);
    // Each path is charged by its LENGTH before it is retained, so the long-named layer costs more by
    // roughly two bytes per extra character per member — not the same flat amount.
    // Two bytes per extra UTF-16 unit, ten members, ~570 extra characters each.
    expect(long - short).toBeGreaterThan(10 * 500 * 2);
  });

  it("refuses before staging completes, with the fixed code and no partial staged file", () => {
    const dir = pool.make();
    const layerTarPath = join(dir, "layer.tar");
    writeFileSync(layerTarPath, buildTar([{ name: "app/a.js", content: "a" }, { name: "app/b.js", content: "b" }, { name: "app/c.js", content: "c" }]));
    const scanDir = join(dir, "scan");
    expect(() => inventoryLayer({
      layerTarPath, layerIndex: 0, scanDir, limits: AUDIT_LIMITS,
      stagingBudget: createStagingBudget(),
      retained: createRetainedStateBudget({ maxLogicalBytes: 2048 }),
    })).toThrow(expect.objectContaining({ code: "AUDIT_TAR_LIMIT_EXCEEDED" }));
    // Whatever was staged before the refusal is complete; nothing half-written is left behind.
    for (const path of scanFilesUnder(scanDir)) expect(readFileSync(path).length).toBeGreaterThanOrEqual(SCAN_HEADER.length);
  });

  it("a budget refusal inside a NESTED archive refuses instead of becoming an undecodable gap", () => {
    const nested = gzipSync(buildTar([{ name: "fixture/a.txt", content: "inner" }]));
    const layerOf = (name: string) => {
      const dir = pool.make();
      const layerTarPath = join(dir, "layer.tar");
      writeFileSync(layerTarPath, buildTar([{ name, content: nested }]));
      return { layerTarPath, scanDir: join(dir, "scan") };
    };
    // What the whole layer costs, measured — the nested expansion's charges come last.
    const measured = createRetainedStateBudget();
    inventoryLayer({ ...layerOf("app/pkg.tgz"), layerIndex: 0, limits: AUDIT_LIMITS, stagingBudget: createStagingBudget(), retained: measured });
    // A ceiling just BELOW that total therefore refuses inside the nested expansion.
    const nestedLayer = layerOf("app/pkg.tgz");
    let thrown: unknown;
    try {
      inventoryLayer({
        ...nestedLayer, layerIndex: 0, limits: AUDIT_LIMITS, stagingBudget: createStagingBudget(),
        retained: createRetainedStateBudget({ maxLogicalBytes: measured.used - 128 }),
      });
    } catch (error) { thrown = error; }
    // It ESCAPED: a resource refusal is not the nested-archive-undecodable gap.
    expect(thrown).toMatchObject({ code: "AUDIT_TAR_LIMIT_EXCEEDED" });
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

/**
 * ROUND 9 — every limitation family is charged, and the authorities grow with the work.
 *
 * The exact-d89 probe found 300 nested limitation records costing 0 bytes and 1 work step: the charged
 * writer was used by three call sites out of nineteen, and the recursive context carried neither
 * authority. Each family below must therefore show BOTH counters growing with the number of gaps, and
 * must refuse under a small ceiling.
 */
describe("every limitation family is charged against the shared authorities (round 9)", () => {
  const runLayer = (members: Parameters<typeof buildTar>[0], limits: Partial<typeof AUDIT_LIMITS> = {}, ceiling?: number) => {
    const dir = pool.make();
    const layerTarPath = join(dir, "layer.tar");
    writeFileSync(layerTarPath, buildTar(members));
    const retained = createRetainedStateBudget(ceiling === undefined ? {} : { maxLogicalBytes: ceiling });
    const work = createWorkBudget({});
    const result = inventoryLayer({
      layerTarPath, layerIndex: 0, scanDir: join(dir, "scan"),
      limits: { ...AUDIT_LIMITS, ...limits }, stagingBudget: createStagingBudget(), retained, work,
    });
    return { retained, work, result, dir };
  };

  const families: [string, (count: number) => Parameters<typeof buildTar>[0], Partial<typeof AUDIT_LIMITS>, string][] = [
    ["unsupported member types", (n) => Array.from({ length: n }, (_, i) => ({ name: `app/odd${i}`, content: "x", rawTypeflag: "M" })), {}, "unsupported-member-type"],
    ["unsafe member paths", (n) => Array.from({ length: n }, (_, i) => ({ name: `/abs${i}.js`, content: "x" })), {}, "unsafe-member-path"],
    ["unexpandable formats", (n) => Array.from({ length: n }, (_, i) => ({ name: `app/pkg${i}.zip`, content: "PK\u0003\u0004zip" })), {}, "unexpanded-archive-format"],
    ["oversized members", (n) => Array.from({ length: n }, (_, i) => ({ name: `app/big${i}.bin`, content: "y".repeat(600) })), { maxMemberBytes: 100 }, "oversized-member"],
    ["nested decode failures", (n) => Array.from({ length: n }, (_, i) => ({ name: `app/broken${i}.tgz`, content: gzipSync(Buffer.from("not a tar at all")) })), {}, "nested-archive-undecodable"],
    ["nested depth limits", (n) => Array.from({ length: n }, (_, i) => ({ name: `app/outer${i}.tgz`, content: gzipSync(buildTar([{ name: "inner.tgz", content: gzipSync(buildTar([{ name: "deep.txt", content: "d" }])) }])) })), {}, "nested-archive-depth-limit"],
    ["nested unsupported members", (n) => Array.from({ length: n }, (_, i) => ({ name: `app/odd${i}.tgz`, content: gzipSync(buildTar([{ name: "weird", content: "x", rawTypeflag: "M" }])) })), {}, "unsupported-member-type"],
  ];

  for (const [label, members, limits, kind] of families) {
    it(`${label}: charge and work grow with the gaps, and a small ceiling refuses`, () => {
      const few = runLayer(members(2), limits);
      const many = runLayer(members(20), limits);
      expect(few.result.limitations.filter((l: { kind: string }) => l.kind === kind).length).toBeGreaterThan(0);
      expect(many.result.limitations.length).toBeGreaterThan(few.result.limitations.length);
      // BOTH authorities move. A zero here is exactly the probe the review ran.
      expect(many.retained.used).toBeGreaterThan(few.retained.used);
      expect(many.work.steps).toBeGreaterThan(few.work.steps);
      // …and the same workload refuses under a ceiling the small case fits inside.
      expect(() => runLayer(members(20), limits, few.retained.used)).toThrow(expect.objectContaining({ code: "AUDIT_TAR_LIMIT_EXCEEDED" }));
    });
  }

  it("EVERY nested entry is charged work, not only the ones that record a gap", () => {
    const withInner = (count: number) => {
      const inner = buildTar(Array.from({ length: count }, (_, i) => ({ name: `inner/f${i}.txt`, content: "i" })));
      return runLayer([{ name: "app/pkg.tgz", content: gzipSync(inner) }]);
    };
    const one = withInner(1);
    const many = withInner(50);
    // Each nested member costs BOTH an entry step and a classification step; charging only one of the
    // two halves this difference.
    expect(many.work.steps - one.work.steps).toBeGreaterThanOrEqual(2 * 49);
  });

  it("a non-zero trailer's gap is charged too", () => {
    const clean = runLayer([{ name: "app/a.js", content: "a" }]);
    const dir = pool.make();
    const layerTarPath = join(dir, "layer.tar");
    writeFileSync(layerTarPath, Buffer.concat([buildTar([{ name: "app/a.js", content: "a" }]), Buffer.from("PK\u0003\u0004")]));
    const retained = createRetainedStateBudget();
    const trailed = inventoryLayer({
      layerTarPath, layerIndex: 0, scanDir: join(dir, "scan"), limits: AUDIT_LIMITS,
      stagingBudget: createStagingBudget(), retained, work: createWorkBudget({}),
    });
    expect(trailed.limitations).toContainEqual({ kind: "archive-trailer-nonzero", layer: 0 });
    expect(retained.used).toBeGreaterThan(clean.retained.used);
  });
});

/** ROUND 9 — a refused reservation must leave NOTHING behind: no file, no header, no map entry. */
describe("staging reserves before any side effect (round 9)", () => {
  const stagedFiles = (scanDir: string) => { try { return scanFilesUnder(scanDir); } catch { return []; } };

  const refuseAt = (ceiling: number, members: Parameters<typeof buildTar>[0]) => {
    const dir = pool.make();
    const layerTarPath = join(dir, "layer.tar");
    writeFileSync(layerTarPath, buildTar(members));
    const scanDir = join(dir, "scan");
    let thrown: unknown;
    try {
      inventoryLayer({
        layerTarPath, layerIndex: 0, scanDir, limits: AUDIT_LIMITS, stagingBudget: createStagingBudget(),
        retained: createRetainedStateBudget({ maxLogicalBytes: ceiling }), work: createWorkBudget({}),
      });
    } catch (error) { thrown = error; }
    return { thrown, scanDir };
  };

  /**
   * A budget that refuses at an EXACT reservation, so each staging path can be refused on its own. It
   * delegates every charge to a real budget, then throws on the chosen `record()` call.
   */
  const refuseOnRecord = (nth: number) => {
    const real = createRetainedStateBudget();
    let records = 0;
    return new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "record") return Reflect.get(target, property, receiver);
        return (fields?: number) => {
          records += 1;
          if (records === nth) throw Object.assign(new Error("refused"), { code: "AUDIT_TAR_LIMIT_EXCEEDED" });
          return target.record(fields);
        };
      },
    });
  };

  const runWith = (retained: ReturnType<typeof createRetainedStateBudget>, members: Parameters<typeof buildTar>[0]) => {
    const dir = pool.make();
    const layerTarPath = join(dir, "layer.tar");
    writeFileSync(layerTarPath, buildTar(members));
    const scanDir = join(dir, "scan");
    let thrown: unknown;
    try {
      inventoryLayer({
        layerTarPath, layerIndex: 0, scanDir, limits: AUDIT_LIMITS,
        stagingBudget: createStagingBudget(), retained, work: createWorkBudget({}),
      });
    } catch (error) { thrown = error; }
    return { thrown, scanDir };
  };

  it("a refused MEMBER record opens no file at all", () => {
    // Reservation order for one member: the surface range's record, then the member's. Refusing the
    // SECOND one lands exactly on the member staging path.
    const { thrown, scanDir } = runWith(refuseOnRecord(2), [{ name: "app/a.js", content: "a" }]);
    expect(thrown).toMatchObject({ code: "AUDIT_TAR_LIMIT_EXCEEDED" });
    const memberFiles = stagedFiles(scanDir).filter((path) => !path.includes(`${archiveSurfaceGroup(0)}/`));
    expect(memberFiles).toEqual([]);
  });

  it("a refused SURFACE record leaves no header-only file", () => {
    // The FIRST record reservation is the surface range's: refusing it must open nothing either.
    const direct = runWith(refuseOnRecord(1), [{ name: "app/a.js", content: "a" }]);
    expect(direct.thrown).toMatchObject({ code: "AUDIT_TAR_LIMIT_EXCEEDED" });
    expect(stagedFiles(direct.scanDir)).toEqual([]);
    // …and the same through the ordinary ceiling path.
    const { thrown, scanDir } = refuseAt(100, [{ name: "app/a.js", content: "a" }]);
    expect(thrown).toMatchObject({ code: "AUDIT_TAR_LIMIT_EXCEEDED" });
    for (const path of stagedFiles(scanDir)) expect(readFileSync(path).length).toBeGreaterThan(SCAN_HEADER.length);
    expect(stagedFiles(join(scanDir, archiveSurfaceGroup(0)))).toEqual([]);
  });
});

/** ROUND 9 — a nested READER limit is still a gap; only the run's own authority escapes. */
describe("nested reader limits keep their gap semantics (round 9)", () => {
  it("a 129-segment path inside a nested archive records nested-archive-undecodable", async () => {
    const deep = `${Array.from({ length: 129 }, (_, i) => `s${i}`).join("/")}/x.js`;
    const nested = gzipSync(buildTar([{ name: deep, content: "x", paxLongName: true }]));
    const result = await inspectLayers([buildTar([{ name: "app/pkg.tgz", content: nested }])]);
    expect(result.coverage.limitations).toContainEqual({ kind: "nested-archive-undecodable", layer: 0, reason: "TarLimitError", depth: 1 });
    expect(result.coverage.complete).toBe(false);
  });

  it("a top-level 129-segment path still refuses the whole run", async () => {
    const deep = `${Array.from({ length: 129 }, (_, i) => `s${i}`).join("/")}/x.js`;
    await expect(inspectLayers([buildTar([{ name: deep, content: "x", paxLongName: true }])]))
      .rejects.toMatchObject({ code: "AUDIT_TAR_LIMIT_EXCEEDED" });
  });
});
