import { describe, expect, it } from "vitest";
import { maturitySnapshotPayloadSchema } from "@/lib/api/schemas";

// Spec (brain-api document revision 1.11, AIO-672): context_health is an optional,
// provenance-only scan-summary object (score, mode, drift_count, versions_behind,
// coverage_pct, broken_link_count, checked_at) with NO default — an omitted field must
// stay distinguishable (undefined) so an older client's re-push can't accidentally clear
// a previously stored summary. The field list mirrors exactly what the workspace producer
// emits (`contextHealthPushFields` in aios-workspace scripts/analyze/report.mjs).

function payload(over: Record<string, unknown> = {}) {
  return {
    date: "2026-07-16",
    signals: {
      delegation_ratio: 0.3, correction_loop_avg: 1.2, error_rate: 0.05,
      cost_per_task: 0.4, tokens_per_task: 30_000, cache_hit_rate: 0.8,
      tool_diversity: 8, verify_tool_rate: 0.3, subagent_usage: 0.5,
    },
    ...over,
  };
}

function contextHealth(over: Record<string, unknown> = {}) {
  return {
    score: 3,
    mode: "workspace",
    drift_count: 2,
    versions_behind: 1,
    coverage_pct: 80,
    broken_link_count: 0,
    checked_at: "2026-07-16",
    ...over,
  };
}

describe("maturitySnapshotPayloadSchema — context_health (brain-api 1.11)", () => {
  it("accepts a valid context_health object verbatim", () => {
    const parsed = maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth() }));
    expect(parsed.context_health).toEqual(contextHealth());
  });

  it("accepts the boundary values (score 0/4, coverage_pct 0/100, nullable fields null)", () => {
    const low = maturitySnapshotPayloadSchema.parse(
      payload({ context_health: contextHealth({ score: 0, coverage_pct: 0, versions_behind: null }) })
    );
    expect(low.context_health?.score).toBe(0);
    expect(low.context_health?.coverage_pct).toBe(0);
    expect(low.context_health?.versions_behind).toBeNull();

    const high = maturitySnapshotPayloadSchema.parse(
      payload({ context_health: contextHealth({ score: 4, coverage_pct: 100 }) })
    );
    expect(high.context_health?.score).toBe(4);
    expect(high.context_health?.coverage_pct).toBe(100);
  });

  // repo mode: versions_behind is always null (toolkit staleness is workspace-only) and
  // coverage_pct comes from claude-coverage, which can itself be null (no git churn).
  it("accepts mode 'repo' with null versions_behind and null coverage_pct", () => {
    const parsed = maturitySnapshotPayloadSchema.parse(
      payload({ context_health: contextHealth({ mode: "repo", versions_behind: null, coverage_pct: null }) })
    );
    expect(parsed.context_health?.mode).toBe("repo");
    expect(parsed.context_health?.coverage_pct).toBeNull();
  });

  it("stays undefined when omitted (distinguishable from an explicit push)", () => {
    expect(maturitySnapshotPayloadSchema.parse(payload()).context_health).toBeUndefined();
  });

  it("rejects an out-of-range score", () => {
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ score: 5 }) }))
    ).toThrow();
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ score: -1 }) }))
    ).toThrow();
  });

  it("rejects an out-of-range coverage_pct", () => {
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ coverage_pct: 101 }) }))
    ).toThrow();
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ coverage_pct: -1 }) }))
    ).toThrow();
  });

  it("rejects an invalid mode", () => {
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ mode: "bogus" }) }))
    ).toThrow();
  });

  it("rejects negative counts and a malformed checked_at", () => {
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ drift_count: -1 }) }))
    ).toThrow();
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ broken_link_count: -1 }) }))
    ).toThrow();
    expect(() =>
      maturitySnapshotPayloadSchema.parse(payload({ context_health: contextHealth({ checked_at: "07/16/2026" }) }))
    ).toThrow();
  });

  // Privacy: the summary is scalars-only. A pushed object carrying paths/detail strings is
  // a contract violation — the schema is strict enough that they never reach the column.
  it("strips any unknown key (no paths or detail strings can ride along into the column)", () => {
    const parsed = maturitySnapshotPayloadSchema.parse(
      payload({
        context_health: contextHealth({
          detail: "0-context/charter.md is missing access: frontmatter",
          paths: ["0-context/charter.md"],
        }),
      })
    );
    expect(parsed.context_health).toEqual(contextHealth());
  });
});
