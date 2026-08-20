import { describe, expect, it } from "vitest";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { fullMetrics } from "@/test/fixtures/codebase-scan";

// Spec (brain-api 1.22 / AIO-995): the scan boundary carries the DENOMINATOR that
// `test_coverage_pct` was measured over, plus the integrity of the run that produced it. All six
// fields are optional and nullable, because the payload has to keep accepting what every scanner
// sends today — and because the one thing a missing value must never mean is zero.
//
// `fullMetrics()` is deliberately the PRE-1.22 block: it names none of the new fields. Every
// "omitted" case below is therefore the real wire shape of an un-upgraded scanner, not a
// hand-built approximation of one.

function payload(metrics: Record<string, unknown> = {}) {
  return {
    codebase: { slug: "acme-api", full_name: "acme/api", open_issues: 0 },
    metrics: { ...fullMetrics(), ...metrics },
    contributions: [],
    issues: [],
  };
}

describe("codebaseScanPayloadSchema — coverage denominator (1.22)", () => {
  it("a pre-1.22 payload still parses, and every new field defaults to null", () => {
    const r = codebaseScanPayloadSchema.safeParse(payload());
    expect(r.success).toBe(true);
    const m = r.success ? r.data.metrics : null;
    // null, not 0. A default of 0 would silently assert "nothing instrumented, nothing skipped"
    // on behalf of a scanner that made no such claim.
    expect(m?.test_coverage_lines_total).toBeNull();
    expect(m?.test_coverage_lines_covered).toBeNull();
    expect(m?.tests_total).toBeNull();
    expect(m?.tests_passed).toBeNull();
    expect(m?.tests_skipped).toBeNull();
    expect(m?.tests_failed).toBeNull();
  });

  it("accepts the full 1.22 block", () => {
    const r = codebaseScanPayloadSchema.safeParse(
      payload({
        test_coverage_pct: 60.25,
        test_coverage_lines_total: 10_647,
        test_coverage_lines_covered: 6_415,
        tests_total: 451,
        tests_passed: 451,
        tests_skipped: 0,
        tests_failed: 0,
      })
    );
    expect(r.success).toBe(true);
    expect(r.success && r.data.metrics.test_coverage_lines_total).toBe(10_647);
  });

  it("an explicit null is accepted and preserved (unknown is a sendable value)", () => {
    const r = codebaseScanPayloadSchema.safeParse(
      payload({ test_coverage_lines_total: null, tests_skipped: null })
    );
    expect(r.success).toBe(true);
    expect(r.success && r.data.metrics.test_coverage_lines_total).toBeNull();
  });

  it("rejects negatives and non-integers — these are COUNTS, not percentages", () => {
    for (const bad of [{ test_coverage_lines_total: -1 }, { tests_skipped: -1 }, { tests_total: 1.5 }]) {
      expect(codebaseScanPayloadSchema.safeParse(payload(bad)).success).toBe(false);
    }
  });

  it("rejects a numerator larger than its denominator", () => {
    // An incoherent pair means the scanner parsed the wrong file. Rejecting at the boundary keeps
    // it from becoming permanent analytics that merely LOOKS measured — the same reason
    // `readiness_pillars` already refuses `passed > total`.
    const covered = codebaseScanPayloadSchema.safeParse(
      payload({ test_coverage_lines_total: 100, test_coverage_lines_covered: 101 })
    );
    expect(covered.success).toBe(false);
    expect(covered.success ? "" : covered.error.issues[0]?.message).toMatch(
      /test_coverage_lines_covered/
    );

    for (const key of ["tests_passed", "tests_skipped", "tests_failed"] as const) {
      const r = codebaseScanPayloadSchema.safeParse(payload({ tests_total: 10, [key]: 11 }));
      expect(r.success, `${key} > tests_total must be rejected`).toBe(false);
      // `toContain`, not `new RegExp(key)`: building a pattern from a variable is a real
      // footgun (an unescaped metacharacter silently changes what is matched) and the
      // assertion here is plain substring containment anyway.
      expect(r.success ? "" : (r.error.issues[0]?.message ?? "")).toContain(key);
    }
  });

  it("a half-known pair is NOT an incoherence — unknown contradicts nothing", () => {
    // The coherence checks must only fire when both sides are present, or an upgraded scanner
    // that reports skips but not a total would start failing at the boundary.
    expect(
      codebaseScanPayloadSchema.safeParse(payload({ tests_skipped: 91, tests_total: null })).success
    ).toBe(true);
    expect(
      codebaseScanPayloadSchema.safeParse(
        payload({ test_coverage_lines_covered: 400, test_coverage_lines_total: null })
      ).success
    ).toBe(true);
  });

  it("equality is allowed at both boundaries (a fully covered, fully passing run)", () => {
    expect(
      codebaseScanPayloadSchema.safeParse(
        payload({
          test_coverage_lines_total: 100,
          test_coverage_lines_covered: 100,
          tests_total: 10,
          tests_passed: 10,
        })
      ).success
    ).toBe(true);
  });
});
