import { describe, expect, it } from "vitest";
import {
  MIN_SCANNER_VERSION,
  isScannerOutdated,
  normalizeStoredScannerField,
  parseScannerVersion,
  scannerStaleness,
  scannerStalenessLabel,
  type ScannerStaleness,
} from "./scanner-version";

/**
 * brain-api 1.24 (AIO-1011) — the three states a scan's scanner build can be in.
 *
 * The bug being closed: 1.22's coverage denominator reached zero of seven repos because each was
 * pinned to a scanner that could not send it. Every scan returned 200, the dashboard said
 * `(scope unknown)`, and nothing anywhere distinguished "old scanner" from "current scanner with
 * genuinely nothing to report". These tests pin the distinction itself — especially the ABSENCE
 * case, which is the one a naive implementation silently reads as a pass.
 */

describe("scannerStaleness — the three states", () => {
  it("CURRENT: a build at or above the declared minimum", () => {
    expect(scannerStaleness("0.2.0")).toBe("current");
    expect(scannerStaleness("0.3.0")).toBe("current");
    expect(scannerStaleness("1.0.0")).toBe("current");
    expect(scannerStaleness("10.20.30")).toBe("current");
  });

  it("STALE: a build that orders below the declared minimum", () => {
    expect(scannerStaleness("0.1.0")).toBe("stale");
    expect(scannerStaleness("0.1.99")).toBe("stale");
    expect(scannerStaleness("0.0.1")).toBe("stale");
  });

  it("UNKNOWN: absent, null, empty, or unparseable — never stale, never current", () => {
    // The load-bearing case. Every scan pushed before 1.24 is here, permanently: the field
    // cannot be backfilled. Reading any of these as "current" would reinstate the exact silence
    // this feature exists to end.
    for (const absent of [null, undefined, "", "   "]) {
      expect(scannerStaleness(absent), String(absent)).toBe("unknown");
    }
    // Unparseable is unknown, NOT stale: we have no ordered value, so we cannot claim it orders
    // below anything. Claiming "stale" here would be an unevidenced verdict.
    for (const junk of ["nightly", "v0.2.0", "0.2", "main", "latest", "0.2.0.0.0-x y"]) {
      expect(scannerStaleness(junk), junk).toBe("unknown");
    }
  });

  it("the three states are mutually exclusive and exhaustive over the union", () => {
    const seen = new Set<ScannerStaleness>([
      scannerStaleness("0.3.0"),
      scannerStaleness("0.1.0"),
      scannerStaleness(null),
    ]);
    expect([...seen].sort()).toEqual(["current", "stale", "unknown"]);
  });

  it("ABSENCE IS DISTINGUISHABLE FROM STALENESS — not merged into one 'bad' bucket", () => {
    // A repo that never declared a build and a repo that declared an old one need DIFFERENT
    // remedies stated to the operator, and the wrong one wastes the reader's time: the first
    // may simply not have re-scanned since 1.24, the second has a pin to bump. Collapsing both
    // to a boolean would lose that, which is why the return type is a three-member union and
    // not `stale: boolean`.
    const unknown = scannerStaleness(null);
    const stale = scannerStaleness("0.1.0");
    expect(unknown).not.toBe(stale);
    expect(scannerStalenessLabel(unknown, null)).not.toBe(
      scannerStalenessLabel(stale, "0.1.0")
    );
    // ...while still both being "not current", which is what the UI gates the badge on.
    expect(isScannerOutdated(unknown)).toBe(true);
    expect(isScannerOutdated(stale)).toBe(true);
    expect(isScannerOutdated(scannerStaleness("0.2.0"))).toBe(false);
  });

  it("an unparseable MINIMUM yields unknown, never a fleet-wide stale verdict", () => {
    // A bug in this repo must not manufacture a staleness claim about every repo in the fleet.
    expect(scannerStaleness("0.3.0", "not-a-version")).toBe("unknown");
  });

  it("boundary: exactly the minimum is current, one patch below is stale", () => {
    expect(scannerStaleness("0.2.0", "0.2.0")).toBe("current");
    expect(scannerStaleness("0.1.9", "0.2.0")).toBe("stale");
    expect(scannerStaleness("0.2.1", "0.2.0")).toBe("current");
  });
});

describe("parseScannerVersion", () => {
  it("accepts release shapes, including pre-release and build suffixes", () => {
    expect(parseScannerVersion("0.2.0")).toEqual([0, 2, 0]);
    expect(parseScannerVersion(" 1.2.3 ")).toEqual([1, 2, 3]);
    // Compared on the numeric core only — an rc of 0.2.0 can emit what 0.2.0 emits.
    expect(parseScannerVersion("0.2.0-rc1")).toEqual([0, 2, 0]);
    expect(parseScannerVersion("0.2.0+dirty")).toEqual([0, 2, 0]);
    // A four-part version is not semver, but its numeric core answers the only question asked:
    // whether the build can emit the fields. Read leniently rather than flagged as unknown.
    expect(parseScannerVersion("1.0.0.0")).toEqual([1, 0, 0]);
    // ...but whitespace is not a suffix. The charset matches the scanner's own, so the two sides
    // cannot disagree about what a version is.
    expect(parseScannerVersion("0.2.0 rc1")).toBeNull();
  });

  it("refuses anything it cannot ORDER", () => {
    for (const bad of [null, undefined, "", "0.2", "v1.0.0", "nightly", "1.0.0 beta"]) {
      expect(parseScannerVersion(bad as string | null), String(bad)).toBeNull();
    }
  });
});

describe("scannerStalenessLabel — the words a reader actually sees", () => {
  it("current renders NO flag at all", () => {
    expect(scannerStalenessLabel("current", "0.2.0")).toBeNull();
  });

  it("stale names the build, the minimum, and the consequence", () => {
    const label = scannerStalenessLabel("stale", "0.1.0");
    expect(label).toContain("0.1.0");
    expect(label).toContain(MIN_SCANNER_VERSION);
    expect(label).toContain("coverage scope");
    // It must not claim the scanner is a distance behind — the measure is a declared minimum.
    expect(label).not.toMatch(/commits behind/);
  });

  it("unknown says unknown, and quotes an unreadable value so the pin can be found", () => {
    expect(scannerStalenessLabel("unknown", null)).toContain("unknown");
    expect(scannerStalenessLabel("unknown", "nightly")).toContain('"nightly"');
    // An unknown build is never described as current or up to date.
    expect(scannerStalenessLabel("unknown", null)).not.toMatch(/current|up to date/i);
  });
});

describe("normalizeStoredScannerField — what gets persisted", () => {
  it("keeps an unparseable version VERBATIM (provenance is most useful when it is wrong)", () => {
    expect(normalizeStoredScannerField("nightly")).toBe("nightly");
    expect(normalizeStoredScannerField(" 0.2.0 ")).toBe("0.2.0");
  });

  it("collapses nothing-at-all to null — an empty string is not a claim", () => {
    for (const empty of [null, undefined, "", "   ", 7 as unknown as string]) {
      expect(normalizeStoredScannerField(empty), String(empty)).toBeNull();
    }
  });

  it("stored-verbatim + read-as-unknown compose: junk persists but never reads as current", () => {
    const stored = normalizeStoredScannerField("nightly");
    expect(stored).toBe("nightly");
    expect(scannerStaleness(stored)).toBe("unknown");
  });
});
