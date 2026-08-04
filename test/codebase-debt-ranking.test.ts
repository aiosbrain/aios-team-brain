import { describe, expect, it } from "vitest";
import {
  buildDebtPatrol,
  rankDebtFinding,
  type DebtFindingInput,
} from "@/lib/codebases/debt-ranking";

const NOW = "2026-08-04T12:00:00.000Z";

function finding(overrides: Partial<DebtFindingInput> = {}): DebtFindingInput {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    fingerprint: "a".repeat(64),
    status: "open",
    check_id: "coverage_lines_pct",
    axis: "test_rigor",
    kind: "quality_issue",
    severity: "high",
    evidence_status: "complete",
    remediation_tier: 1,
    occurrence_count: 2,
    first_seen_at: "2026-05-01T12:00:00.000Z",
    last_seen_at: "2026-08-04T10:00:00.000Z",
    decision_expires_at: null,
    ...overrides,
  };
}

const CONTEXT = { commitsWindow: 90, windowDays: 90, now: NOW };

describe("explainable debt ranking", () => {
  it("separates principal from interest and normalizes only over known evidence", () => {
    const ranked = rankDebtFinding(finding(), CONTEXT);

    expect(ranked).toMatchObject({
      priorityScore: 69.9,
      scoreCoveragePct: 83,
      principalScore: 73.3,
      principalCoveragePct: 75,
      interestScore: 60,
      interestCoveragePct: 88.9,
      active: true,
    });
    expect(
      ranked.factors
        .filter((factor) => factor.state === "unknown")
        .map((factor) => factor.key),
    ).toEqual(["reachability", "agent_friction", "review_cost"]);
    expect(
      ranked.factors.find((factor) => factor.key === "reachability"),
    ).toMatchObject({
      points: null,
      value: "unknown",
    });
  });

  it("keeps a measured zero distinct from an unknown input", () => {
    const ranked = rankDebtFinding(
      finding({
        occurrence_count: 1,
        first_seen_at: "2026-08-03T12:00:00.000Z",
      }),
      { commitsWindow: 0, windowDays: 90, now: NOW },
    );

    expect(
      ranked.factors.find((factor) => factor.key === "recurrence"),
    ).toMatchObject({
      state: "known",
      points: 0,
    });
    expect(
      ranked.factors.find((factor) => factor.key === "change_pressure"),
    ).toMatchObject({
      state: "known",
      points: 0,
      value: "0 commits / 30d",
    });
    expect(
      ranked.factors.find((factor) => factor.key === "review_cost"),
    ).toMatchObject({
      state: "unknown",
      points: null,
    });
  });

  it("orders ties deterministically by the stable fingerprint", () => {
    const second = finding({
      id: "00000000-0000-4000-8000-000000000002",
      fingerprint: "b".repeat(64),
    });
    const patrol = buildDebtPatrol([second, finding()], CONTEXT);

    expect(patrol.ranked.map((ranking) => ranking.findingId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(patrol.ranked.map((ranking) => ranking.rank)).toEqual([1, 2]);
  });

  it("suppresses a current decision and re-enters it after expiry without erasing status", () => {
    const current = finding({
      status: "risk_accepted",
      decision_expires_at: "2026-08-05T12:00:00.000Z",
    });
    const expired = finding({
      id: "00000000-0000-4000-8000-000000000002",
      fingerprint: "b".repeat(64),
      status: "accepted",
      decision_expires_at: "2026-08-03T12:00:00.000Z",
    });
    const patrol = buildDebtPatrol([current, expired], CONTEXT);

    expect(patrol.rollups).toMatchObject({
      active: 1,
      suppressed: 1,
      expired: 1,
    });
    expect(patrol.ranked[0]).toMatchObject({
      findingId: expired.id,
      effectiveStatus: "reopened",
      decisionExpired: true,
      active: true,
    });
    expect(patrol.rollups.lifecycle).toMatchObject({
      risk_accepted: 1,
      accepted: 1,
    });
  });

  it("labels North Star values as patrol proxies or unknowns, never verified outcomes", () => {
    const patrol = buildDebtPatrol([finding()], CONTEXT);
    const states = Object.fromEntries(
      patrol.rollups.northStar.map((metric) => [metric.key, metric.state]),
    );

    expect(states).toEqual({
      change_risk: "proxy",
      agent_rework: "unknown",
      reviewer_effort: "unknown",
      future_development_cost: "proxy",
    });
  });

  it("reports no-data rollups as unavailable rather than measured zero", () => {
    const patrol = buildDebtPatrol([], CONTEXT);
    const futureCost = patrol.rollups.northStar.find(
      (metric) => metric.key === "future_development_cost",
    );

    expect(patrol.rollups.admission).toMatchObject({
      scored: 0,
      meanCoveragePct: null,
    });
    expect(futureCost).toMatchObject({
      state: "unknown",
      value: null,
      unit: "unknown",
    });
  });
});
