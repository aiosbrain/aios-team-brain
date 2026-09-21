import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  TarFormatError,
  bufferSource,
  classifyLinkTarget,
  classifyMemberPath,
  parsePaxRecords,
  readTarMembers,
} from "../scripts/staging-ops/image-audit/tar-reader.mjs";
import { UNSUPPORTED_FORMATS, unsupportedMagicFormat } from "../scripts/staging-ops/image-audit/export-walk.mjs";
import { SCAN_HEADER } from "../scripts/staging-ops/image-audit/scan-surface.mjs";
import { buildTar, syntheticSecret, ustarSplit } from "./helpers/tar-fixture";
import { inspectSynthetic, scanFiles, scanSurface, scratchPool, synthesizeImage } from "./helpers/synthetic-image";

/**
 * PUB-07's hostile-archive row, against the reader that will read real image layers.
 *
 * The property under test is NOT "the reader sanitises a path". It is that the reader has no path to
 * sanitise: it parses members, classifies their names, and writes nothing. So each hostile case
 * asserts BOTH that the member is reported AND that the classification says why it would be unsafe to
 * extract — because a reader that silently dropped hostile members would hide content from the scan,
 * which is the same coverage hole from the other side.
 */

const members = (tar: Buffer) => [...readTarMembers(bufferSource(tar))];

describe("tar reader: ordinary members are read exactly", () => {
  it("reads names, types, modes and content hashes", () => {
    const body = "console.log('ok')\n";
    const tar = buildTar([
      { name: "app/", type: "directory" },
      { name: "app/index.js", content: body, mode: 0o644 },
      { name: "app/link", type: "symlink", linkTarget: "index.js" },
    ]);
    const parsed = members(tar);
    expect(parsed.map((m) => [m.name, m.type])).toEqual([
      ["app/", "directory"],
      ["app/index.js", "file"],
      ["app/link", "symlink"],
    ]);
    expect(parsed[1].content()).toEqual({
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    });
  });

  it("streams content to the caller's sink and nowhere else", () => {
    // The ONE way bytes leave the reader. A member's own name never reaches a filesystem call,
    // which is what makes every hostile case below data rather than a vulnerability.
    const tar = buildTar([{ name: "/etc/shadow", content: "root:x:0:0" }]);
    const chunks: Buffer[] = [];
    const [member] = members(tar);
    member.content((chunk: Buffer) => chunks.push(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("root:x:0:0");
    expect(member.path).toEqual({ safe: false, reason: "absolute" });
  });

  it("refuses to read content from a non-file member", () => {
    const [dir] = members(buildTar([{ name: "app/", type: "directory" }]));
    expect(() => dir.content()).toThrow(/no content/);
  });
});

describe("tar reader: long names (PUB-07, L3)", () => {
  const deep = `app/${"nested-directory-segment/".repeat(9)}a-file-with-a-very-long-name.json`;

  it("reads a GNU long-name member at its FULL path", () => {
    expect(deep.length).toBeGreaterThan(100);
    const [member] = members(buildTar([{ name: deep, content: "{}", gnuLongName: true }]));
    // A reader that ignored the `L` header would report the truncated 100-byte ustar name — a real
    // path, plausible, and wrong, so the inventory comparison would call a known file unexpected.
    expect(member.name).toBe(deep);
    expect(member.content().bytes).toBe(2);
  });

  it("reads a PAX long-name member at its FULL path, including its link target", () => {
    const [member] = members(buildTar([
      { name: deep, type: "symlink", linkTarget: `../${"up/".repeat(20)}target`, paxLongName: true },
    ]));
    expect(member.name).toBe(deep);
    expect(member.linkTarget).toBe(`../${"up/".repeat(20)}target`);
  });

  /**
   * A name too long for the 100-byte ustar `name` field but representable as `prefix` + `/` + `name`.
   *
   * DELIBERATELY NOT `deep`. At 262 bytes `deep` exceeds ustar's 155 + 1 + 100 ceiling entirely, so
   * no split of it exists — which is why the long-name cases above carry GNU/PAX metadata. The old
   * fixture papered over that by truncating, and the test then asserted a path the archive did not
   * contain.
   */
  const prefixSplit = `app/${"nested-directory-segment/".repeat(4)}a-file-with-a-very-long-name.json`;

  it("reads a ustar prefix-split long name at its FULL path", () => {
    expect(prefixSplit.length).toBeGreaterThan(100);
    // The fixture really did use the prefix field — otherwise this case would be testing an ordinary
    // short name that happens to be long enough to read impressively.
    const split = ustarSplit(prefixSplit);
    expect(split.prefix).toBeTruthy();
    expect(Buffer.byteLength(split.name)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(String(split.prefix))).toBeLessThanOrEqual(155);

    const [member] = members(buildTar([{ name: prefixSplit, content: "{}" }]));
    expect(member.name).toBe(prefixSplit);
    expect(member.content().bytes).toBe(2);
  });

  it("REFUSES to build a plain ustar member whose name no split can represent", () => {
    // The fixture must fail loudly rather than encode a truncated name that a later assertion would
    // then have to be weakened to match.
    expect(() => ustarSplit(deep)).toThrow(/ustar cannot represent/);
    expect(() => buildTar([{ name: deep, content: "{}" }])).toThrow(/gnuLongName or paxLongName/);
  });

  it("applies a PAX header to the NEXT member only", () => {
    const parsed = members(buildTar([
      { name: deep, content: "a", paxLongName: true },
      { name: "app/plain.txt", content: "b" },
    ]));
    expect(parsed.map((m) => m.name)).toEqual([deep, "app/plain.txt"]);
  });

  /**
   * THE BUG THIS EXISTS FOR, found by re-reading rather than by running. A PAX `size` record
   * overrides the ustar size field, and for a member too large for the octal field the ustar size is
   * `0`. Using the ustar size for the STRIDE reads no content AND lands the next header read inside
   * this member's data — so the rest of the archive parses into plausible garbage and the layer
   * inventory looks complete while being wrong.
   */
  it("honours a PAX size record for BOTH the content length and the stride to the next member", () => {
    const body = "x".repeat(1500); // three data blocks, so a wrong stride cannot land by luck
    const parsed = members(buildTar([
      { name: "app/big.bin", content: body, paxSize: true },
      { name: "app/after.txt", content: "still here" },
    ]));
    expect(parsed.map((m) => m.name)).toEqual(["app/big.bin", "app/after.txt"]);
    expect(parsed[0].size).toBe(1500);
    expect(parsed[0].content()).toEqual({ sha256: createHash("sha256").update(body).digest("hex"), bytes: 1500 });
    // The member AFTER it is the real check: a reader that took the ustar `0` would have resumed
    // inside `big.bin`'s data and never reached this one intact.
    expect(parsed[1].content().bytes).toBe(10);
  });

  it("refuses a PAX size record that runs past the end of the archive", () => {
    // A size record is attacker-controlled data, so honouring it must not mean trusting it. Dropping
    // the end-of-archive blocks AND a data block leaves the declared 1500 bytes unsatisfiable.
    const tar = buildTar([{ name: "app/lying.bin", content: "x".repeat(1500), paxSize: true }]);
    expect(() => members(tar.subarray(0, tar.length - 2048))).toThrow(TarFormatError);
  });

  it("surfaces an unknown member typeflag as `unsupported` rather than dropping it", () => {
    // Dropped silently, an unknown type is bytes nobody looked at reported as a clean scan. The
    // layer walk turns this into a recorded coverage limitation.
    const [member] = members(buildTar([{ name: "app/odd", content: "data", rawTypeflag: "M" }]));
    expect(member.type).toBe("unsupported");
    expect(member.typeflag).toBe("M");
  });

  it("parses PAX records whose length field counts its own digits", () => {
    expect(parsePaxRecords("30 path=some/fairly/long/path\n")).toEqual({ path: "some/fairly/long/path" });
    expect(() => parsePaxRecords("9999 path=x\n")).toThrow(TarFormatError);
    expect(() => parsePaxRecords("10 nokeysep\n")).toThrow(TarFormatError);
  });
});

describe("tar reader: hostile members are REPORTED, never extracted (PUB-07)", () => {
  it("classifies an absolute member path", () => {
    const [member] = members(buildTar([{ name: "/etc/cron.d/backdoor", content: "x" }]));
    expect(member.name).toBe("/etc/cron.d/backdoor");
    expect(member.path).toEqual({ safe: false, reason: "absolute" });
  });

  it("classifies a parent-traversal member path", () => {
    const [member] = members(buildTar([{ name: "app/../../../root/.ssh/id_ed25519", content: "x" }]));
    expect(member.path).toEqual({ safe: false, reason: "traversal" });
  });

  it("classifies an escaping symlink AND the member that would be written through it", () => {
    // The two halves of the classic escape. Both are inventoried; neither is followed, because the
    // reader resolves no path at all.
    const parsed = members(buildTar([
      { name: "app/escape", type: "symlink", linkTarget: "../../../../etc" },
      { name: "app/escape/passwd", content: "root:x:0:0" },
    ]));
    expect(parsed[0].type).toBe("symlink");
    expect(classifyLinkTarget(parsed[0].linkTarget)).toEqual({ escapes: true, reason: "traversal" });
    // The follow-through member's own name is ordinary — which is exactly why the LINK has to be
    // classified: nothing about `app/escape/passwd` looks unsafe on its own.
    expect(parsed[1].path.safe).toBe(true);
  });

  it("classifies an absolute symlink target and an external hardlink", () => {
    const parsed = members(buildTar([
      { name: "app/abs", type: "symlink", linkTarget: "/etc/shadow" },
      { name: "app/hard", type: "hardlink", linkTarget: "/etc/shadow" },
    ]));
    expect(parsed.map((m) => m.type)).toEqual(["symlink", "hardlink"]);
    for (const member of parsed) {
      expect(classifyLinkTarget(member.linkTarget)).toEqual({ escapes: true, reason: "absolute" });
      // A link carries no content to read, so there is no host file to open even by mistake.
      expect(() => member.content()).toThrow(/no content/);
    }
  });

  /**
   * WHAT `classifyLinkTarget` CAN AND CANNOT KNOW, stated as a test.
   *
   * It is given a target and nothing else, so it reasons from the archive ROOT: depth starts at zero.
   * `../lib/index.js` is contained only if the link's own parent directory is at least one level
   * down — information this function is never handed. It therefore calls a LEADING `..` traversal,
   * conservatively, and that is the correct answer for the input it has.
   *
   * The earlier version of this case asserted `../lib/index.js` was proven contained. Making that
   * pass would have meant treating a leading `..` as safe for every target in every archive — i.e.
   * weakening the classification that the escaping-symlink case above depends on, to satisfy a claim
   * the function has no evidence for. Nothing here follows or opens a link either way.
   */
  it("classifies a target that stays inside the archive root as contained", () => {
    expect(classifyLinkTarget("node_modules/.bin/tsc")).toEqual({ escapes: false, reason: "contained" });
    // Descends and comes back up WITHOUT passing the root: contained, and the depth arithmetic is
    // what proves it rather than the absence of a `..`.
    expect(classifyLinkTarget("lib/../lib/index.js")).toEqual({ escapes: false, reason: "contained" });
    expect(classifyLinkTarget("./sibling.js")).toEqual({ escapes: false, reason: "contained" });
  });

  it("classifies a target that climbs above the archive root as an escape", () => {
    // The conservative half of the same rule: with no member location to anchor it, a LEADING `..`
    // cannot be shown to stay inside.
    expect(classifyLinkTarget("../lib/index.js")).toEqual({ escapes: true, reason: "traversal" });
    expect(classifyLinkTarget("app/../../etc/passwd")).toEqual({ escapes: true, reason: "traversal" });
    expect(classifyMemberPath("app/ok.js")).toEqual({ safe: true, reason: "relative" });
    expect(classifyMemberPath("")).toEqual({ safe: false, reason: "empty" });
  });
});

describe("tar reader: a corrupt or oversized archive FAILS (PUB-02)", () => {
  it("refuses a header whose checksum does not match its bytes", () => {
    expect(() => members(buildTar([{ name: "app/x", content: "y", corruptChecksum: true }]))).toThrow(TarFormatError);
  });

  it("refuses a member whose data runs past the end of the archive", () => {
    const tar = buildTar([{ name: "app/x", content: "y".repeat(1024) }]);
    expect(() => members(tar.subarray(0, 700))).toThrow(TarFormatError);
  });

  it("refuses an archive with more members than the limit allows", () => {
    const tar = buildTar([{ name: "a", content: "1" }, { name: "b", content: "2" }, { name: "c", content: "3" }]);
    expect(() => [...readTarMembers(bufferSource(tar), { maxMembers: 2 })]).toThrow(/2-member limit/);
  });

  /**
   * INVERTED (AC-AUDIT-03). This test used to pin the reader IGNORING a secret-bearing trailer, which
   * is exactly the independent reviewer's witness: bytes distributed with the layer that no scanner
   * ever saw, under a complete-coverage claim. The trailer is now either reported as surface to scan
   * or — where there is no surface to put it on — refused. It is never silently discarded.
   */
  it("reports trailing bytes after the end-of-archive marker instead of discarding them", () => {
    const secret = syntheticSecret();
    const tar = Buffer.concat([buildTar([{ name: "app/x", content: "y" }]), Buffer.from(secret)]);
    const surfaced: Buffer[] = [];
    const parsed = [...readTarMembers(bufferSource(tar), {
      onSurface: ({ offset, length }: { offset: number; length: number }) => surfaced.push(tar.subarray(offset, offset + length)),
    })];
    expect(parsed.map((m) => m.name)).toEqual(["app/x"]);
    expect(Buffer.concat(surfaced).toString("latin1")).toContain(secret);
    expect(() => [...readTarMembers(bufferSource(tar), { nonzeroTrailer: "refuse" })]).toThrow(TarFormatError);
  });
});

// ---------------------------------------------------------------------------
// A container this audit cannot expand is a RECORDED gap — recognised by its magic
// ---------------------------------------------------------------------------

/**
 * THE DEFECT THESE EXIST FOR, established by an independent probe against the frozen inspector.
 *
 * `app/payload.zip.gz` holding a gzipped, DEFLATED ZIP returned `identityVerified: true`,
 * `coverage.complete: true` and an EMPTY limitations array — while the marker inside the ZIP was
 * absent from every staged scan file. The bare-gzip branch inflated the wrapper, staged the ZIP
 * bytes under the synthetic name `…#inflated`, and reclassified THAT: a name the end-anchored
 * `.zip` pattern cannot match, over bytes that are neither gzip nor tar. Classification fell through
 * to "an ordinary file" and nothing recorded a thing. An extensionless or renamed ZIP at the top
 * level had the same hole without needing the wrapper at all.
 *
 * So the pairs below are the same pairs the rest of this suite uses: either the content reaches the
 * scan surface, or the gap is RECORDED. "Neither" is what shipped.
 *
 * These drive the REAL `inspectExport` through `inspectSynthetic`; nothing here runs a scanner.
 */
const pool = scratchPool();
afterAll(() => pool.cleanup());

/** CRC-32 (IEEE), computed here so the ZIP fixtures below are real archives rather than magic bytes. */
function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/**
 * A single-entry ZIP, DEFLATED, built by hand — no new dependency and no reuse of the code under
 * test. Deflated on purpose: the sentinel does not appear in the archive's bytes, so "the sentinel
 * is absent from the scan surface" measures whether the container was expanded rather than whether
 * a plaintext copy happened to be lying around.
 */
function zipArchive(name: string, content: Buffer | string): Buffer {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const deflated = deflateRawSync(body);
  const nameBytes = Buffer.from(name, "ascii");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // "PK\x03\x04"
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc32(body), 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // "PK\x01\x02"
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(body), 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + deflated.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // "PK\x05\x06"
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, end]);
}

interface Limitation { kind: string; layer?: number; depth?: number; format?: string; extension?: string }
const limitationsOf = (result: { coverage: { limitations: readonly Limitation[] } }) => [...result.coverage.limitations];

describe("an unsupported container is recognised by its MAGIC, at every depth", () => {
  it("is a real deflated ZIP whose plaintext is NOT in its own bytes", () => {
    // The fixture's own precondition. Without it, every "the sentinel did not reach the scan
    // surface" assertion below could be true because the sentinel was never in the archive either.
    const secret = syntheticSecret();
    const zip = zipArchive("secret.txt", `TOKEN=${secret}`);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zip.toString("latin1")).not.toContain(secret);
  });

  it("records an EXTENSIONLESS member whose content is a ZIP, and still stages its bytes", async () => {
    const secret = syntheticSecret();
    const zip = zipArchive("secret.txt", `TOKEN=${secret}`);
    const image = synthesizeImage([buildTar([{ name: "app/data", content: zip }])]);
    const result = await inspectSynthetic(image, pool.make());

    expect(limitationsOf(result)).toContainEqual({ kind: "unexpanded-archive-format", layer: 0, format: "zip" });
    expect(result.coverage.complete).toBe(false);
    expect(scanSurface(result.scanDir)).not.toContain(secret);
    // STAGING IS UNCHANGED by the recognition: the member is still staged through the same
    // byte-preserving representation, so a scanner rule that CAN read the container still sees it.
    // Recording a gap must not become a reason to stop staging the bytes.
    const staged = scanFiles(`${result.scanDir}/L0`);
    expect(staged).toHaveLength(1);
    expect(readFileSync(staged[0]).subarray(SCAN_HEADER.length).equals(zip)).toBe(true);
  });

  it("records a RENAMED ZIP by its magic, not by the name it was given", async () => {
    const image = synthesizeImage([buildTar([{ name: "app/notes.txt", content: zipArchive("a.txt", "x") }])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(limitationsOf(result)).toContainEqual({ kind: "unexpanded-archive-format", layer: 0, format: "zip" });
  });

  /** The probe's exact shape: a supported wrapper around an unsupported container. */
  it("records the ZIP inside a BARE GZIP, where the synthetic `#inflated` name matches nothing", async () => {
    const secret = syntheticSecret();
    const zip = zipArchive("secret.txt", `TOKEN=${secret}`);
    const image = synthesizeImage([buildTar([{ name: "app/payload.zip.gz", content: gzipSync(zip) }])]);
    const result = await inspectSynthetic(image, pool.make());

    // `depth: 1` says the gap is in the INFLATED payload, not in the wrapper that was staged at
    // depth 0 — the two are different gaps and the old code recorded neither.
    expect(limitationsOf(result)).toContainEqual({ kind: "unexpanded-archive-format", layer: 0, format: "zip", depth: 1 });
    expect(result.coverage.complete).toBe(false);
    expect(scanSurface(result.scanDir)).not.toContain(secret);
  });

  it("records a ZIP found inside a nested tar.gz", async () => {
    const zip = zipArchive("secret.txt", "TOKEN=x");
    const outer = gzipSync(buildTar([{ name: "vendor/bundle", content: zip }]));
    const image = synthesizeImage([buildTar([{ name: "app/outer.tgz", content: outer }])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(limitationsOf(result)).toContainEqual({ kind: "unexpanded-archive-format", layer: 0, format: "zip", depth: 1 });
  });

  it("records a ZIP inside a gzip inside a tar, two levels down", async () => {
    const zip = zipArchive("secret.txt", "TOKEN=x");
    const outer = gzipSync(buildTar([{ name: "vendor/inner.gz", content: gzipSync(zip) }]));
    const image = synthesizeImage([buildTar([{ name: "app/outer.tgz", content: outer }])]);
    // The depth bound is raised so the walk REACHES level two; at the default it stops one level up
    // and records `nested-archive-depth-limit` instead, which is the other honest answer.
    const result = await inspectSynthetic(image, pool.make(), { maxNestedArchiveDepth: 2 });
    expect(limitationsOf(result)).toContainEqual({ kind: "unexpanded-archive-format", layer: 0, format: "zip", depth: 2 });
    expect(result.coverage.complete).toBe(false);
  });

  /** Every format in the closed list, so adding one to the table without a test is not possible. */
  it("records EVERY container format in the closed vocabulary, under its own label", async () => {
    const signatures: Record<string, number[]> = {
      zip: [0x50, 0x4b, 0x03, 0x04],
      xz: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
      // `BZh` plus the block-size digit a real stream always carries — the digit is part of the
      // signature, not payload.
      bzip2: [0x42, 0x5a, 0x68, 0x39],
      zstd: [0x28, 0xb5, 0x2f, 0xfd],
      "7z": [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
      rar: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
      ar: [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a],
      rpm: [0xed, 0xab, 0xee, 0xdb],
    };
    // The vocabulary itself is asserted, so a format added to the source without a row here fails.
    expect([...UNSUPPORTED_FORMATS].sort()).toEqual(Object.keys(signatures).sort());

    for (const [format, magic] of Object.entries(signatures)) {
      const content = Buffer.concat([Buffer.from(magic), Buffer.from(" container payload")]);
      const image = synthesizeImage([buildTar([{ name: "app/blob", content }])]);
      const result = await inspectSynthetic(image, pool.make());
      expect(limitationsOf(result), `${format} magic was not recorded`)
        .toContainEqual({ kind: "unexpanded-archive-format", layer: 0, format });
    }
  });

  /**
   * bzip2's signature is `BZh` AND the block-size digit, on the recogniser directly.
   *
   * With three bytes only, any file whose first three bytes are `BZh` — a text file beginning with
   * those letters — was labelled an unexpandable bzip2 container. Fail-closed rather than a coverage
   * hole, but the label was simply wrong, and a limitation that fires on ordinary content stops
   * meaning anything. All nine digits are asserted, so a signature table that special-cased one of
   * them cannot pass.
   */
  it("recognises bzip2 only when the block-size digit follows `BZh`", () => {
    for (const digit of "123456789") {
      expect(unsupportedMagicFormat(Buffer.from(`BZh${digit} payload`)), `BZh${digit} was not bzip2`).toBe("bzip2");
    }
    // `0` is not a legal block size, `X` is not a digit, and three bytes are not a signature.
    for (const near of ["BZh0 payload", "BZhX payload", "BZh", "BZ", "BZhh1"]) {
      expect(unsupportedMagicFormat(Buffer.from(near)), `${near} was read as bzip2`).toBeUndefined();
    }
  });

  /** The NEGATIVE CONTROL. A limitation that fires on ordinary content stops meaning anything. */
  it("does NOT flag a file that merely contains a signature later, or starts with a near-miss", async () => {
    const image = synthesizeImage([buildTar([
      // Prose that opens with the three bzip2 letters but no block-size digit.
      { name: "app/bzip.md", content: "BZh is the bzip2 magic; the digit after it is the block size" },
      // The signature at offset 200: ordinary source quoting a magic number, which is what this file
      // is. Only the START of content decides.
      { name: "app/doc.md", content: Buffer.concat([Buffer.alloc(200, 0x20), Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("tail")]) },
      // Starts with `PK` but is not any signature.
      { name: "app/notes.txt", content: "PKZIP archives begin with PK followed by two more bytes" },
      // One byte short of the xz signature.
      { name: "app/bytes.bin", content: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x01, 0x00]) },
    ])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(limitationsOf(result)).toEqual([]);
    expect(result.coverage.complete).toBe(true);
  });

  /**
   * THE POSITIVE CONTROL, and the negative control on the recogniser itself: a gzip of PLAINTEXT is
   * expanded, reaches the scanner, and records nothing. A recogniser that answered "zip" for
   * everything would satisfy every case above and break exactly this one.
   */
  it("still expands a plaintext gzip to complete coverage, with the sentinel on the scan surface", async () => {
    const secret = syntheticSecret();
    const image = synthesizeImage([buildTar([{ name: "app/payload.gz", content: gzipSync(Buffer.from(`TOKEN=${secret}`)) }])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(result.coverage.limitations).toEqual([]);
    expect(result.coverage.complete).toBe(true);
    expect(scanSurface(result.scanDir)).toContain(secret);
  });

  /** A limitation reaches the PUBLIC artifact, so the label can only be one of the eight strings. */
  it("never echoes the member's name, the container's inner name or its bytes into the record", async () => {
    const memberMarker = syntheticSecret("name_");
    const innerMarker = syntheticSecret("inner_");
    const contentMarker = syntheticSecret();
    const zip = zipArchive(`${innerMarker}.txt`, `TOKEN=${contentMarker}`);
    const image = synthesizeImage([buildTar([{ name: `app/${memberMarker}.zzz`, content: zip }])]);
    const result = await inspectSynthetic(image, pool.make());

    const recorded = JSON.stringify(result.coverage.limitations);
    expect(recorded).toContain('"format":"zip"');
    for (const withheld of [memberMarker, innerMarker, contentMarker]) {
      expect(recorded, `the limitation emits ${withheld}`).not.toContain(withheld);
    }
    // ∀, not ∃: no limitation anywhere carries a format outside the closed vocabulary.
    for (const limitation of limitationsOf(result)) {
      if (limitation.format !== undefined) expect(UNSUPPORTED_FORMATS).toContain(limitation.format);
    }
  });

  /** The NAME-derived gap is untouched: `extension` and `format` are different evidence. */
  it("keeps reporting a name-recognised archive by its extension", async () => {
    const image = synthesizeImage([buildTar([{ name: "app/vendor/bundle.whl", content: "not really a wheel" }])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(limitationsOf(result)).toContainEqual({ kind: "unexpanded-archive-format", layer: 0, extension: ".whl" });
  });
});
