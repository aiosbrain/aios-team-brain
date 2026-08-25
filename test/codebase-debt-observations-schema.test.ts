import { describe, expect, it } from "vitest";
import { codeMetricsSchema } from "@/lib/api/schemas";

function metrics(recentCommit: Record<string, unknown>) {
  return {
    head_sha: "abc123d",
    loc: 100,
    files: 4,
    commits_window: 1,
    ai_commits_window: 0,
    additions_window: 3,
    deletions_window: 2,
    recent_commits: [recentCommit],
    has_claude_md: false,
    has_agents_md: false,
    agents_md_count: 0,
    skills_count: 0,
    commands_count: 0,
  };
}

const coherentFix = {
  sha: "abc123d",
  message: "fix: repair parser",
  commit_classification: { scheme: "conventional-commit-v1", type: "fix" },
  fix_analysis: {
    method: "first-parent-line-blame-v1",
    candidate_parent_lines: 5,
    blamed_parent_lines: 4,
    age_buckets: {
      "0_1d": 1,
      "2_7d": 1,
      "8_30d": 1,
      "31_90d": 1,
      "91_365d": 0,
      "366d_plus": 0,
    },
    prior_fix_parent_lines: 2,
  },
};

describe("Brain API 1.23 recent commit observations", () => {
  it("keeps legacy commit objects valid and accepts coherent observations", () => {
    expect(
      codeMetricsSchema.safeParse(
        metrics({
          sha: 12345,
          additions: "legacy-value",
          custom_legacy: true,
        }),
      ).success,
    ).toBe(true);
    expect(codeMetricsSchema.safeParse(metrics(coherentFix)).success).toBe(
      true,
    );
  });

  it.each([
    [
      "blame exceeds candidates",
      { ...coherentFix.fix_analysis, blamed_parent_lines: 6 },
    ],
    [
      "age buckets do not sum to blamed lines",
      {
        ...coherentFix.fix_analysis,
        age_buckets: { ...coherentFix.fix_analysis.age_buckets, "0_1d": 0 },
      },
    ],
    [
      "prior fixes exceed blamed lines",
      { ...coherentFix.fix_analysis, prior_fix_parent_lines: 5 },
    ],
  ])("rejects incoherent %s", (_name, fix_analysis) => {
    expect(
      codeMetricsSchema.safeParse(metrics({ ...coherentFix, fix_analysis }))
        .success,
    ).toBe(false);
  });

  it("rejects fix analysis attached to a non-fix classification", () => {
    expect(
      codeMetricsSchema.safeParse(
        metrics({
          ...coherentFix,
          commit_classification: {
            scheme: "conventional-commit-v1",
            type: "feat",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown observation fields so source paths cannot cross the boundary", () => {
    expect(
      codeMetricsSchema.safeParse(
        metrics({
          ...coherentFix,
          fix_analysis: {
            ...coherentFix.fix_analysis,
            source_path: "src/private.ts",
          },
        }),
      ).success,
    ).toBe(false);
  });
});
