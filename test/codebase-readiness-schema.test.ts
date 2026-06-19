import { describe, expect, it } from "vitest";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { fullMetrics } from "@/test/fixtures/codebase-scan";

// Spec: the scan boundary must reject malformed AEM agent-readiness so bad scanner
// output can't become permanent analytics — level is the fixed L0..L5 ladder, and a
// pillar can never report more checks passed than exist. Readiness stays fully optional
// (older scanners that omit it keep working). The core raw-scan fields are REQUIRED so a
// sparse readiness-only push is rejected (can't zero out an existing rich row on upsert).

function payload(metrics: Record<string, unknown>) {
  return {
    codebase: { slug: "acme-api", full_name: "acme/api", open_issues: 0 },
    metrics: { ...fullMetrics(), ...metrics },
    contributions: [],
    issues: [],
  };
}

describe("codebaseScanPayloadSchema — readiness validation", () => {
  it("accepts a well-formed readiness block", () => {
    const r = codebaseScanPayloadSchema.safeParse(
      payload({
        readiness_level: "L3",
        readiness_pct: 67,
        readiness_pillars: { testing: { passed: 2, total: 2 }, docs: { passed: 2, total: 3 } },
        readiness_rubric_version: "1.0.0",
      })
    );
    expect(r.success).toBe(true);
  });

  it("defaults readiness when omitted (backward compatible)", () => {
    const r = codebaseScanPayloadSchema.parse(payload({}));
    expect(r.metrics.readiness_level).toBeNull();
    expect(r.metrics.readiness_pillars).toEqual({});
  });

  it("rejects a level outside the L0..L5 ladder", () => {
    const r = codebaseScanPayloadSchema.safeParse(payload({ readiness_level: "L9" }));
    expect(r.success).toBe(false);
  });

  it("rejects a pillar reporting passed > total", () => {
    const r = codebaseScanPayloadSchema.safeParse(
      payload({ readiness_level: "L2", readiness_pillars: { testing: { passed: 5, total: 2 } } })
    );
    expect(r.success).toBe(false);
  });

  it("rejects a SPARSE metrics payload (readiness-only, missing the raw-scan block)", () => {
    // This is the shape the old `aios assess-codebase --push` sent — it must be rejected so
    // it can't upsert a row that zeroes the existing commits/loc/recent_commits analytics.
    const r = codebaseScanPayloadSchema.safeParse({
      codebase: { slug: "acme-api", full_name: "acme/api", open_issues: 0 },
      metrics: {
        head_sha: "a".repeat(40),
        has_claude_md: true,
        skills_count: 3,
        readiness_level: "L3",
        readiness_pct: 67,
      },
      contributions: [],
      issues: [],
    });
    expect(r.success).toBe(false);
  });

  it("accepts a full metrics payload (the ingestion scanner's shape)", () => {
    const r = codebaseScanPayloadSchema.safeParse({
      codebase: { slug: "acme-api", full_name: "acme/api", open_issues: 0 },
      metrics: fullMetrics(),
      contributions: [],
      issues: [],
    });
    expect(r.success).toBe(true);
  });
});
