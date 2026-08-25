import { describe, expect, it } from "vitest";
import {
  deriveCodebaseDebtKpis,
  deriveCommitDebtKpis,
  deriveDebtMovementKpis,
  type DebtKpiFinding,
} from "@/lib/codebases/debt-kpis";

function finding(
  id: string,
  status: DebtKpiFinding["status"],
  events: DebtKpiFinding["events"],
  overrides: Partial<DebtKpiFinding> = {},
): DebtKpiFinding {
  return {
    id,
    status,
    severity: "medium",
    evidence_status: "complete",
    remediation_tier: 1,
    occurrence_count: status === "reopened" ? 2 : 1,
    first_seen_at: "2026-05-01T00:00:00Z",
    decision_expires_at: null,
    events,
    ...overrides,
  };
}

describe("debt movement KPIs", () => {
  it("separates actionable stock, suppressions, arrivals, and real closures", () => {
    const result = deriveDebtMovementKpis(
      [
        finding("open", "open", [
          { event_type: "detected", observed_at: "2026-08-22T00:00:00Z" },
        ]),
        finding(
          "reopened",
          "reopened",
          [
            { event_type: "resolved", observed_at: "2026-08-10T00:00:00Z" },
            { event_type: "reopened", observed_at: "2026-08-24T00:00:00Z" },
          ],
          { severity: "critical" },
        ),
        finding("accepted", "accepted", [
          { event_type: "accepted", observed_at: "2026-08-23T00:00:00Z" },
        ]),
        finding("resolved", "resolved", [
          { event_type: "detected", observed_at: "2026-08-20T00:00:00Z" },
          { event_type: "resolved", observed_at: "2026-08-25T00:00:00Z" },
        ]),
      ],
      {
        rangeStart: "2026-08-19T00:00:00Z",
        rangeEnd: "2026-08-25T23:59:59Z",
      },
    );

    expect(result).toMatchObject({
      actionable: 2,
      actionableOpen: 1,
      actionableReopened: 1,
      suppressed: 1,
      totalKnownActive: 3,
      detected: 2,
      reopened: 1,
      arrivals: 3,
      closures: 1,
      netFlow: 2,
      severity: { low: 0, medium: 1, high: 0, critical: 1 },
      recurrence: { reopened: 1, eligibleResolvedFindings: 2, ratePct: 50 },
    });
    expect(result.suppressions.accepted).toBe(1);
    expect(result.openAge["0_7d"]).toBe(2);
  });

  it("returns expired decisions to stock and starts age at expiry", () => {
    const result = deriveDebtMovementKpis(
      [
        finding("expired", "risk_accepted", [], {
          decision_expires_at: "2026-08-10T00:00:00Z",
        }),
      ],
      {
        rangeStart: "2026-08-01T00:00:00Z",
        rangeEnd: "2026-08-25T00:00:00Z",
      },
    );

    expect(result.actionable).toBe(1);
    expect(result.suppressed).toBe(0);
    expect(result.expiryReturnsToActionable).toBe(1);
    expect(result.openAge["8_30d"]).toBe(1);
    expect(result.expiryFlowAvailable).toBe(false);
  });

  it("keeps an unknown age bucket instead of guessing from first_seen_at", () => {
    const result = deriveDebtMovementKpis(
      [finding("missing-event", "open", [])],
      {
        rangeStart: "2026-08-01T00:00:00Z",
        rangeEnd: "2026-08-25T00:00:00Z",
      },
    );
    expect(result.openAge.unknown).toBe(1);
  });
});

describe("commit debt KPIs", () => {
  it("publishes mix and coverage denominators separately", () => {
    const result = deriveCommitDebtKpis(
      [
        {
          commit_classification: {
            scheme: "conventional-commit-v1",
            type: "fix",
          },
          fix_analysis: {
            method: "first-parent-line-blame-v1",
            candidate_parent_lines: 10,
            blamed_parent_lines: 8,
            age_buckets: {
              "0_1d": 1,
              "2_7d": 1,
              "8_30d": 2,
              "31_90d": 1,
              "91_365d": 2,
              "366d_plus": 1,
            },
            prior_fix_parent_lines: 2,
          },
        },
        {
          commit_classification: {
            scheme: "conventional-commit-v1",
            type: "feat",
          },
        },
        {
          commit_classification: {
            scheme: "conventional-commit-v1",
            type: "other",
          },
        },
        {
          commit_classification: {
            scheme: "conventional-commit-v1",
            type: "unparseable",
          },
        },
        {},
      ],
      { commitsWindow: 20, scannerWindowDays: 90 },
    );

    expect(result).toMatchObject({
      observedCommits: 5,
      feedCoveragePct: 25,
      classifiedCommits: 4,
      classificationCoveragePct: 60,
      fixSharePct: 50,
      fixAnalysisCoveragePct: 100,
      blameCoveragePct: 80,
      fixOnFixPct: 25,
      priorFixParentLines: 2,
    });
    expect(result.classes).toEqual({
      fix: 1,
      feat: 1,
      other: 1,
      unparseable: 1,
    });
    expect(result.fixAge["8_30d"]).toBe(2);
  });

  it("ignores incoherent fix analysis instead of manufacturing a result", () => {
    const result = deriveCommitDebtKpis(
      [
        {
          commit_classification: {
            scheme: "conventional-commit-v1",
            type: "fix",
          },
          fix_analysis: {
            method: "first-parent-line-blame-v1",
            candidate_parent_lines: 2,
            blamed_parent_lines: 3,
            age_buckets: {
              "0_1d": 0,
              "2_7d": 0,
              "8_30d": 0,
              "31_90d": 0,
              "91_365d": 0,
              "366d_plus": 3,
            },
            prior_fix_parent_lines: 0,
          },
        },
      ],
      { commitsWindow: 1, scannerWindowDays: 90 },
    );
    expect(result.fixAnalysisCommits).toBe(0);
    expect(result.blameCoveragePct).toBeNull();
    expect(result.fixOnFixPct).toBeNull();
  });

  it("assembles movement and commit evidence without conflating them", () => {
    const result = deriveCodebaseDebtKpis({
      findings: [
        finding("a", "open", [
          { event_type: "detected", observed_at: "2026-08-24T00:00:00Z" },
        ]),
      ],
      commits: [],
      rangeStart: "2026-08-01T00:00:00Z",
      rangeEnd: "2026-08-25T00:00:00Z",
      commitsWindow: 0,
      scannerWindowDays: 90,
    });
    expect(result.movement.actionable).toBe(1);
    expect(result.commits.fixSharePct).toBeNull();
  });
});
