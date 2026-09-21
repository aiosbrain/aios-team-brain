import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { AUDIT_LIMITS } from "../scripts/staging-ops/image-audit/subject.mjs";
import {
  CONFIG_SCAN_GROUP,
  SCAN_HEADER,
  SCAN_REPRESENTATION,
  assessCanary,
  canaryFixtures,
  canarySentinel,
  wrapForScan,
} from "../scripts/staging-ops/image-audit/scan-surface.mjs";
import { buildOutputCategory } from "../scripts/staging-ops/image-audit/export-walk.mjs";
import { SCANNER, scannerArgs, scannerSettings } from "../scripts/staging-ops/image-audit/scanner.mjs";
import { scannerIsolation } from "../scripts/staging-ops/image-audit.mjs";
import { createOperationBudget } from "../scripts/staging-ops/operation-deadline.mjs";
import { buildTar, syntheticSecret } from "./helpers/tar-fixture";
import { inspectSynthetic, memberScanFiles, scanFiles, scanSurface, scratchPool, synthesizeImage } from "./helpers/synthetic-image";

/**
 * THE THREE MEASURED COVERAGE DEFECTS (F1, F2, F3) and the bounds that were recorded but unenforced
 * (F5, F11, F12).
 *
 * Each of the first three was established by an independent adversarial probe against the frozen
 * implementation, and each produced the same failure: a clean-looking result over content nobody
 * scanned, with NO limitation recorded anywhere. So the assertions here come in pairs — the gap is
 * either closed (the content reaches the scan surface) or RECORDED (a limitation makes coverage
 * incomplete). "Neither" is the state that shipped, and it is what these tests exist to forbid.
 *
 * WHAT THEY DO NOT CLAIM. Nothing here runs the pinned scanner. These tests measure what the audit
 * STAGES and what it RECORDS; whether the pinned Linux binary then reads that representation is a
 * separate measurement, made at runtime by the capability canary and verified by the coordinator on
 * the actual pinned asset.
 */

const pool = scratchPool();
afterAll(() => pool.cleanup());

/** ELF magic — the exact four bytes the pinned scanner was measured to skip a file for. */
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

describe("F1 — a staged scan file is a fixed header plus the member's EXACT bytes", () => {
  it("preserves every original byte, including binary magic and an embedded NUL", async () => {
    const secret = syntheticSecret();
    // Deliberately hostile to a lossy representation: binary magic at offset 0, a NUL byte, a
    // high byte that is not valid UTF-8 on its own, and the sentinel behind all of it.
    const original = Buffer.concat([ELF, Buffer.from([0x00, 0xff]), Buffer.from(`\nTOKEN=${secret}\n`, "ascii")]);
    const image = synthesizeImage([buildTar([{ name: "app/bin/tool", content: original }])]);
    const result = await inspectSynthetic(image, pool.make());

    const staged = memberScanFiles(join(result.scanDir, "L0"));
    expect(staged).toHaveLength(1);
    const bytes = readFileSync(staged[0]);

    // (1) The header is EXACTLY the recorded one — the representation the feasibility probe measured.
    expect(bytes.subarray(0, SCAN_HEADER.length).equals(SCAN_HEADER)).toBe(true);
    expect(SCAN_HEADER.length).toBe(23);
    // (2) EXACT SUFFIX EQUALITY. Everything after the header is the original member, byte for byte.
    //     This is the assertion that rules out strings extraction, re-encoding, truncation,
    //     normalisation and dropped NULs in one comparison instead of four separate hopes.
    expect(bytes.subarray(SCAN_HEADER.length).equals(original)).toBe(true);
    expect(bytes.length).toBe(SCAN_HEADER.length + original.length);
    // (3) …and the bytes a lossy representation would have eaten are still there.
    expect(bytes.includes(0x00)).toBe(true);
    expect(bytes.includes(0xff)).toBe(true);
    expect(bytes.subarray(SCAN_HEADER.length, SCAN_HEADER.length + 4).equals(ELF)).toBe(true);
  });

  it("leaves IDENTITY on the original bytes, never on the representation", async () => {
    const original = Buffer.concat([ELF, Buffer.from("payload", "ascii")]);
    const image = synthesizeImage([buildTar([{ name: "app/bin/tool", content: original }])]);
    const result = await inspectSynthetic(image, pool.make());
    const { createHash } = await import("node:crypto");
    const originalSha = createHash("sha256").update(original).digest("hex");
    const wrappedSha = createHash("sha256").update(wrapForScan(original)).digest("hex");

    // The inventory comparison hashes what the IMAGE ships. Hashing the scanner's copy instead would
    // make every first-party file a content-mismatch against its Git blob.
    expect(result.appMembers[0].sha256).toBe(originalSha);
    expect(result.appMembers[0].sha256).not.toBe(wrappedSha);
  });

  it("reports the image's own bytes and the scanner's surface as SEPARATE figures", async () => {
    const body = Buffer.alloc(100, 0x41);
    const layer = buildTar([{ name: "app/a", content: body }]);
    const image = synthesizeImage([layer]);
    const result = await inspectSynthetic(image, pool.make());

    // Stating only the surface would overstate how much IMAGE was read; stating only the content
    // would hide that the scanner's input is not byte-identical to the member.
    //
    // THE ARCHIVE SURFACE (AC-AUDIT-02) is every byte of the layer that is not member content: here
    // the member's header, its padding and the two end blocks — the layer minus the 100 content bytes.
    // It is counted on its own AND charged to the same staged total.
    expect(result.coverage.archiveSurfaceBytes).toBe(layer.length - 100);
    expect(result.coverage.stagedBytes).toBe(layer.length);
    expect(result.coverage.configBytes).toBe(image.configBytes.length);
    // One member file, one archive-surface file and the config, each carrying one header.
    expect(result.coverage.representationOverheadBytes).toBe(3 * SCAN_HEADER.length);
    expect(result.coverage.scanSurfaceBytes).toBe(layer.length + image.configBytes.length + 3 * SCAN_HEADER.length);
    expect(result.coverage.representation).toBe(SCAN_REPRESENTATION.version);
    // The surface figure is a real measurement of the tree, not an arithmetic claim about it.
    const onDisk = scanFiles(result.scanDir).reduce((total, path) => total + readFileSync(path).length, 0);
    expect(onDisk).toBe(result.coverage.scanSurfaceBytes);
  });

  it("stages the image CONFIG through the same representation and the same id vocabulary", async () => {
    const secret = syntheticSecret("ghs_");
    const image = synthesizeImage([buildTar([{ name: "app/a", content: "x" }])], {
      env: ["PATH=/usr/local/bin", `REGISTRY_TOKEN=${secret}`],
    });
    const result = await inspectSynthetic(image, pool.make());
    expect(result.configScanId).toBe(`${CONFIG_SCAN_GROUP}/000000${SCAN_REPRESENTATION.suffix}`);
    const bytes = readFileSync(join(result.scanDir, result.configScanId));
    expect(bytes.subarray(0, SCAN_HEADER.length).equals(SCAN_HEADER)).toBe(true);
    expect(bytes.subarray(SCAN_HEADER.length).equals(image.configBytes)).toBe(true);
    expect(bytes.toString("utf8")).toContain(secret);
  });

  /**
   * The runtime capability check. It cannot run the pinned binary here, so what is tested is the
   * DECISION: a wrapped miss must be `unverified`, because that is the outcome that becomes a coverage
   * limitation and blocks the transition.
   */
  describe("the capability canary decides coverage, and never contributes a finding", () => {
    it("is UNVERIFIED when the scanner did not detect the sentinel in this representation", () => {
      expect(assessCanary({ wrappedFindings: 0, unwrappedFindings: 0 }).status).toBe("unverified");
      // Even with the negative control absent: what matters is whether the representation was read.
      expect(assessCanary({ wrappedFindings: 0, unwrappedFindings: 1 }).status).toBe("unverified");
      // A missing/garbled count is not a pass either.
      expect(assessCanary({ wrappedFindings: undefined, unwrappedFindings: 0 }).status).toBe("unverified");
    });

    it("is VERIFIED when the wrapped fixture was detected, and reports the negative control honestly", () => {
      const reproduced = assessCanary({ wrappedFindings: 1, unwrappedFindings: 0 });
      expect(reproduced.status).toBe("verified");
      expect(reproduced.binaryMagicSkipReproduced).toBe(true);
      // The skip not reproducing is a FACT to record, not a failure and not something to imply away.
      const notReproduced = assessCanary({ wrappedFindings: 1, unwrappedFindings: 1 });
      expect(notReproduced.status).toBe("verified");
      expect(notReproduced.binaryMagicSkipReproduced).toBe(false);
    });

    it("builds both fixtures from ONE sentinel, differing only by the representation", () => {
      const sentinel = canarySentinel();
      const fixtures = canaryFixtures(sentinel);
      expect(fixtures.unwrapped.subarray(0, 4).equals(ELF)).toBe(true);
      expect(fixtures.wrapped.equals(wrapForScan(fixtures.unwrapped))).toBe(true);
      expect(fixtures.unwrapped.toString("ascii")).toContain(sentinel);
      // Minted per run and rule-shaped, so it cannot become a literal a repository scanner finds.
      expect(sentinel).toMatch(/^ghp_[0-9A-Za-z]{36}$/);
      expect(canarySentinel()).not.toBe(sentinel);
    });
  });
});

describe("F2 — a staged id carries NO suffix inherited from the member's name", () => {
  it("gives byte-identical members the same neutral suffix whatever they were called", async () => {
    const secret = syntheticSecret();
    const body = `GITHUB_TOKEN=${secret}\n`;
    // The exact three the adversarial probe used: identical bytes, three suffixes, one finding.
    const image = synthesizeImage([buildTar([
      { name: "app/neutral.txt", content: body },
      { name: "app/payload.bin", content: body },
      { name: "app/payload.svg", content: body },
    ])]);
    const result = await inspectSynthetic(image, pool.make());

    const memberEntries = [...result.staged].filter(([, detail]) => detail.name !== undefined);
    expect(memberEntries.map(([id]) => id)).toEqual([
      `L0/000000${SCAN_REPRESENTATION.suffix}`,
      `L0/000001${SCAN_REPRESENTATION.suffix}`,
      `L0/000002${SCAN_REPRESENTATION.suffix}`,
    ]);
    // The archive surface is named from the same closed vocabulary, under the layer's `M/` group, and
    // carries a fixed category and no name at all.
    const surfaceEntries = [...result.staged].filter(([, detail]) => detail.name === undefined);
    expect(surfaceEntries.map(([id]) => id)).toEqual([`L0/M/000000${SCAN_REPRESENTATION.suffix}`]);
    expect(surfaceEntries.map(([, detail]) => detail)).toEqual([{ category: "archive-metadata", layer: 0, depth: 0 }]);
    // ∀, not ∃: no staged file ANYWHERE in the tree ends in a suffix the image chose.
    for (const path of scanFiles(result.scanDir)) {
      expect(path.endsWith(SCAN_REPRESENTATION.suffix), `${path} is not neutrally named`).toBe(true);
    }
    expect(scanFiles(result.scanDir).some((path) => /\.(bin|svg)$/.test(path))).toBe(false);
    // The real names survive PRIVATELY, which is what a bounded coordinator rerun resolves through.
    expect(memberEntries.map(([, detail]) => detail.name))
      .toEqual(["app/neutral.txt", "app/payload.bin", "app/payload.svg"]);
  });

  it("keeps the neutral suffix for content the SCANNER would key on, at every depth", async () => {
    const nested = gzipSync(buildTar([{ name: "fixture/payload.svg", content: "x" }]));
    const image = synthesizeImage([buildTar([{ name: "app/pkg.tgz", content: nested }])]);
    const result = await inspectSynthetic(image, pool.make());
    for (const path of scanFiles(result.scanDir)) {
      expect(path.endsWith(SCAN_REPRESENTATION.suffix), `${path} is not neutrally named`).toBe(true);
    }
  });
});

describe("F13 — the checkout's ignore file cannot suppress an image finding", () => {
  it("passes an EXPLICIT ignore path, and demands the flag of the pinned binary", () => {
    const args = scannerArgs({ sourceDir: "/s", reportPath: "/r", ignorePath: "/scratch/x/.gitleaksignore" });
    expect(args).toContain("--gitleaks-ignore-path");
    expect(args[args.indexOf("--gitleaks-ignore-path") + 1]).toBe("/scratch/x/.gitleaksignore");
    // Measured against the pinned binary's own `detect --help` at run time. A dropped argument would
    // silently restore the documented default of `.` — the working directory.
    expect(SCANNER.requiredFlags).toContain("--gitleaks-ignore-path");
  });

  it("writes an EMPTY audit-owned ignore file, in a working directory outside the checkout", () => {
    const scratch = pool.make();
    const { cwd, ignorePath } = scannerIsolation(scratch);
    expect(readFileSync(ignorePath, "utf8")).toBe("");
    expect(ignorePath.endsWith("/.gitleaksignore")).toBe(true);
    expect(cwd.startsWith(scratch)).toBe(true);
    // The whole point: not the repository, whose `.gitleaksignore` is what this rules out.
    expect(cwd.startsWith(process.cwd())).toBe(false);
  });

  it("records the isolation as PRESENCE, never as a scratch path", () => {
    const isolated = scannerSettings(scannerArgs({ sourceDir: "/s", reportPath: "/r", ignorePath: "/scratch/x/.gitleaksignore" }));
    expect(isolated.gitleaksIgnorePath).toContain("audit-owned");
    expect(JSON.stringify(isolated)).not.toContain("/scratch/x");
    // An invocation WITHOUT it says so, rather than claiming an isolation it did not have.
    const bare = scannerSettings(scannerArgs({ sourceDir: "/s", reportPath: "/r" }));
    expect(bare.gitleaksIgnorePath).toContain("unset");
  });

  it("states the inherited default-config allowlist as a limitation instead of denying it", () => {
    const stated = scannerSettings(scannerArgs({ sourceDir: "/s", reportPath: "/r" })).ruleLimitations.join(" ");
    expect(stated).toContain("global allowlist");
    expect(stated).toContain("neutral generated id");
    // The honest ceiling: rules this version does not carry find nothing, and the record says so.
    expect(stated).toMatch(/rule set/);
  });
});

describe("F3 — every expanded member is reclassified, at every depth", () => {
  const secret = syntheticSecret();
  const doubleNested = () => {
    const inner = gzipSync(buildTar([{ name: "fixture/key.txt", content: `TOKEN=${secret}` }]));
    const outer = gzipSync(buildTar([{ name: "inner.tgz", content: inner }]));
    return synthesizeImage([buildTar([{ name: "app/outer.tgz", content: outer }])]);
  };

  /**
   * THE WITNESS. The frozen implementation returned identity verified, coverage COMPLETE and an empty
   * limitations array for exactly this fixture, while the second-level sentinel was absent from every
   * staged file. Two opaque `.tgz` blobs were "scanned" and nothing said otherwise.
   */
  it("records the DEPTH BOUND for a second-level archive instead of reporting complete coverage", async () => {
    const result = await inspectSynthetic(doubleNested(), pool.make());
    expect(result.coverage.limitations).toContainEqual({ kind: "nested-archive-depth-limit", layer: 0, depth: 2 });
    expect(result.coverage.complete).toBe(false);
    // The sentinel really is absent, which is what makes the limitation the honest answer rather than
    // a redundant note beside content that was scanned anyway.
    expect(scanSurface(result.scanDir)).not.toContain(secret);
  });

  it("…and reaches it when the depth bound allows the second level", async () => {
    const result = await inspectSynthetic(doubleNested(), pool.make(), { maxNestedArchiveDepth: 2 });
    expect(scanSurface(result.scanDir)).toContain(secret);
    expect(result.coverage.limitations).toEqual([]);
    expect(result.coverage.complete).toBe(true);
  });

  it("records an unexpandable format found INSIDE an archive, with its depth", async () => {
    const outer = gzipSync(buildTar([{ name: "vendor/bundle.zip", content: "PK opaque" }]));
    const image = synthesizeImage([buildTar([{ name: "app/outer.tgz", content: outer }])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(result.coverage.limitations).toContainEqual({ kind: "unexpanded-archive-format", layer: 0, extension: ".zip", depth: 1 });
    expect(result.coverage.complete).toBe(false);
  });

  it("records an unknown member TYPE found inside an archive", async () => {
    const outer = gzipSync(buildTar([{ name: "odd", content: "unread bytes", rawTypeflag: "M" }]));
    const image = synthesizeImage([buildTar([{ name: "app/outer.tgz", content: outer }])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(result.coverage.limitations).toContainEqual({ kind: "unsupported-member-type", layer: 0, typeflag: "M", depth: 1 });
  });

  it("reclassifies the INFLATED bytes of a bare gzip, so a DOUBLE gzip is not silently opaque", async () => {
    const inner = gzipSync(Buffer.from(`TOKEN=${secret}`, "ascii"));
    const image = synthesizeImage([buildTar([{ name: "app/blob.gz", content: gzipSync(inner) }])]);
    // One level inflates to gzip bytes again. Stopping there would stage a compressed blob and call
    // the layer covered — the same gap one level down.
    const bounded = await inspectSynthetic(image, pool.make());
    expect(bounded.coverage.limitations).toContainEqual({ kind: "nested-archive-depth-limit", layer: 0, depth: 2 });
    expect(scanSurface(bounded.scanDir)).not.toContain(secret);

    const deeper = await inspectSynthetic(image, pool.make(), { maxNestedArchiveDepth: 2 });
    expect(scanSurface(deeper.scanDir)).toContain(secret);
    expect(deeper.coverage.complete).toBe(true);
  });

  it("still expands ONE level cleanly, so the bound is a bound and not a refusal to look", async () => {
    const nested = gzipSync(buildTar([{ name: "fixture/key.txt", content: `TOKEN=${secret}` }]));
    const image = synthesizeImage([buildTar([{ name: "app/node_modules/pkg/test.tar.gz", content: nested }])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(scanSurface(result.scanDir)).toContain(secret);
    expect(result.coverage.complete).toBe(true);
  });
});

describe("recorded bounds are ENFORCED, not merely recorded (F5, F11, F12)", () => {
  it("F12: refuses a manifest declaring more layers than the bound, before any decode", async () => {
    const dir = pool.make();
    const image = synthesizeImage([
      buildTar([{ name: "app/a.js", content: "1" }]),
      buildTar([{ name: "app/b.js", content: "2" }]),
    ]);
    await expect(inspectSynthetic(image, dir, { maxLayerCount: 1 }))
      .rejects.toMatchObject({ code: "AUDIT_LAYER_COUNT_EXCEEDED" });
    // BEFORE any decode: nothing was written to the layer scratch at all.
    expect(readdirSync(join(dir, "layers"))).toEqual([]);
  });

  it("F5: aborts a layer decode past its output ceiling and removes the partial layer", async () => {
    const dir = pool.make();
    // A small compressed blob that inflates well past a tiny ceiling — the decompression-bomb shape,
    // in miniature. Nothing between the decompressor and the disk used to count these bytes.
    const image = synthesizeImage([buildTar([{ name: "app/big.bin", content: Buffer.alloc(64 * 1024, 7) }])]);
    expect(image.blobs[0].length).toBeLessThan(4096);
    await expect(inspectSynthetic(image, dir, { maxLayerDecodedBytes: 1024 }))
      .rejects.toMatchObject({ code: "AUDIT_LAYER_OUTPUT_LIMIT" });
    // A truncated decode is not a layer. Leaving it would let a later pass read it as a whole one.
    expect(readdirSync(join(dir, "layers"))).toEqual([]);
  });

  it("F11: aborts the inspection when the internal budget is exhausted, with a fixed code", async () => {
    let clock = 0;
    const deadline = createOperationBudget("audit", 1, { now: () => clock });
    clock = 60_000; // the budget expired before the walk reached its first layer
    const image = synthesizeImage([buildTar([{ name: "app/a.js", content: "1" }])]);
    await expect(inspectSynthetic(image, pool.make(), {}, { deadline }))
      .rejects.toMatchObject({ code: "STAGING_OPERATION_TIMEOUT" });
  });

  /**
   * F11's OTHER half: the clock has to reach PASS 1.
   *
   * `indexExportByDigest` hashes every member of the export before a single layer is decoded — real
   * work on a multi-gigabyte archive — and it took no deadline at all. The abort above would have
   * happened only after that whole walk, which on a pathological export is exactly the budget the
   * deadline exists to protect. So the FIRST clock check of an inspection must be the indexing one.
   */
  it("F11: the FIRST clock check happens at export indexing, before any layer is decoded", async () => {
    const dir = pool.make();
    const consulted: string[] = [];
    const expired = {
      assert(operation?: string) {
        consulted.push(String(operation));
        throw Object.assign(new Error("the budget is exhausted"), { code: "STAGING_OPERATION_TIMEOUT" });
      },
    };
    const image = synthesizeImage([buildTar([{ name: "app/a.js", content: "1" }])]);
    await expect(inspectSynthetic(image, dir, {}, { deadline: expired }))
      .rejects.toMatchObject({ code: "STAGING_OPERATION_TIMEOUT" });
    // Which operation was being asked about is the pin: without the deadline threaded into pass 1,
    // the first thing consulted is the layer loop, after the whole export has been hashed.
    expect(consulted).toEqual(["export index"]);
    expect(readdirSync(join(dir, "layers"))).toEqual([]);
  });

  it("F11: …and a healthy budget consults the index first, then the layers", async () => {
    // The negative control on the case above: a deadline that never throws must still be ASKED, in
    // that order, and the inspection must complete.
    const consulted: string[] = [];
    const image = synthesizeImage([buildTar([{ name: "app/a.js", content: "1" }])]);
    const result = await inspectSynthetic(image, pool.make(), {}, {
      deadline: { assert(operation?: string) { consulted.push(String(operation)); return undefined; } },
    });
    expect(consulted[0]).toBe("export index");
    expect(consulted).toContain("layer inspection");
    expect(result.coverage.complete).toBe(true);
  });

  it("F11: a budget with time left does NOT abort a healthy inspection", async () => {
    // The negative control. Without it, a deadline that threw unconditionally would satisfy the test
    // above while breaking every real run.
    const deadline = createOperationBudget("audit", 60_000);
    const image = synthesizeImage([buildTar([{ name: "app/a.js", content: "1" }])]);
    const result = await inspectSynthetic(image, pool.make(), {}, { deadline });
    expect(result.coverage.complete).toBe(true);
  });

  it("PUB-01: the internal deadline plus the reserved write time fits inside the job timeout", () => {
    expect(AUDIT_LIMITS.internalDeadlineMs + AUDIT_LIMITS.evidenceReserveMs)
      .toBeLessThanOrEqual(AUDIT_LIMITS.jobTimeoutMinutes * 60_000);
    expect(AUDIT_LIMITS.evidenceReserveMs).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("records the REPRESENTATION's own overhead as a bound of its own", async () => {
    const image = synthesizeImage([buildTar([
      { name: "app/a", content: "1" },
      { name: "app/b", content: "2" },
    ])]);
    // Room for exactly one member's header. The second cannot be represented at all.
    const result = await inspectSynthetic(image, pool.make(), { maxScanSurfaceOverheadBytes: SCAN_HEADER.length });
    // Named for the counter that actually refused it: "the image was too big to stage" and "the
    // representation ran out of its own allowance" are different gaps with different remedies.
    expect(result.coverage.limitations).toContainEqual({ kind: "scan-surface-overhead-exhausted", layer: 0 });
    expect(result.coverage.complete).toBe(false);
  });
});

describe("F8 — outside-/app content is accounted for by fixed category, never by name", () => {
  it("classifies npm caches, npm logs, apt state and keyrings, and admits the rest is base image", () => {
    expect(buildOutputCategory("root/.npm/_logs/2026-09-09T00_00_00_000Z-debug-0.log")).toBe("npm-log");
    expect(buildOutputCategory("usr/local/lib/npm-debug.log")).toBe("npm-log");
    expect(buildOutputCategory("root/.npm/_cacache/index-v5/aa/bb/cc")).toBe("npm-cache");
    expect(buildOutputCategory("var/lib/apt/lists/deb.debian.org_dists_bookworm_Release")).toBe("apt-cache");
    expect(buildOutputCategory("usr/share/keyrings/nodesource.gpg")).toBe("apt-keyring");
    // The catch-all is honest about being one, rather than implying everything was identified.
    expect(buildOutputCategory("usr/lib/x86_64-linux-gnu/libc.so.6")).toBe("base-image-content");
  });

  it("aggregates counts and bytes for categories ACTUALLY encountered, and names no path", async () => {
    const image = synthesizeImage([buildTar([
      { name: "app/index.js", content: "ok" },
      { name: "root/.npm/_cacache/tmp/secretish-name", content: "aaaa" },
      { name: "var/lib/apt/lists/deb.debian.org_Release", content: "bb" },
    ])]);
    const result = await inspectSynthetic(image, pool.make());
    expect(result.buildOutputs).toEqual({
      "apt-cache": { files: 1, bytes: 2 },
      "npm-cache": { files: 1, bytes: 4 },
    });
    // Nothing here ASSUMES a category is present: the ones the image did not contain are absent.
    expect(Object.keys(result.buildOutputs)).not.toContain("npm-log");
    expect(Object.keys(result.buildOutputs)).not.toContain("base-image-content");
    // …and no path is emitted, which is the half a count could otherwise smuggle.
    expect(JSON.stringify(result.buildOutputs)).not.toContain("secretish-name");
    // The accounting is NOT an exemption: those files were staged for the scan like any other.
    expect(scanSurface(result.scanDir)).toContain("aaaa");
    // `/app` membership is unchanged by the accounting.
    expect(result.appMembers.map((member) => member.path)).toEqual(["app/index.js"]);
  });
});
