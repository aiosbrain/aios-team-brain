import type { FindingStatus } from "@/lib/codebases/finding-ledger";

export type DebtFactorGroup = "principal" | "interest" | "confidence" | "cost";
export type DebtFactorState = "known" | "unknown";

export interface DebtFactor {
  key:
    | "severity"
    | "reachability"
    | "recurrence"
    | "age"
    | "change_pressure"
    | "agent_friction"
    | "evidence_confidence"
    | "remediation_cost"
    | "review_cost";
  label: string;
  group: DebtFactorGroup;
  state: DebtFactorState;
  points: number | null;
  weight: number;
  value: string;
  explanation: string;
  provenance: string;
  verifierClass: "scanner" | "ledger" | "repository" | "unavailable";
}

export interface DebtFindingInput {
  id: string;
  fingerprint: string;
  status: FindingStatus;
  check_id: string;
  axis: string;
  kind: "quality_issue" | "evidence_gap";
  severity: "low" | "medium" | "high" | "critical";
  evidence_status: "complete" | "partial" | "missing" | "stale" | "error";
  remediation_tier: number;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  decision_expires_at?: string | null;
}

export interface DebtRankingContext {
  commitsWindow: number | null;
  windowDays: number | null;
  now: string;
}

export interface RankedDebtFinding {
  findingId: string;
  rank: number;
  priorityScore: number;
  scoreCoveragePct: number;
  principalScore: number;
  principalCoveragePct: number;
  interestScore: number;
  interestCoveragePct: number;
  effectiveStatus: FindingStatus;
  decisionExpired: boolean;
  active: boolean;
  factors: DebtFactor[];
}

export interface DebtPatrolRollups {
  lifecycle: Record<FindingStatus, number>;
  active: number;
  suppressed: number;
  expired: number;
  recurring: number;
  evidenceUnknown: number;
  age: {
    fresh: number;
    established: number;
    aging: number;
    entrenched: number;
  };
  admission: {
    scored: number;
    meanCoveragePct: number | null;
    unknownFactors: Record<string, number>;
  };
  northStar: Array<{
    key:
      | "change_risk"
      | "agent_rework"
      | "reviewer_effort"
      | "future_development_cost";
    label: string;
    state: "proxy" | "unknown";
    value: number | null;
    unit: string;
    explanation: string;
  }>;
}

export interface DebtPatrol {
  ranked: RankedDebtFinding[];
  rollups: DebtPatrolRollups;
  generatedAt: string;
  methodologyVersion: "1";
}

const DECISION_STATUSES = new Set<FindingStatus>([
  "accepted",
  "risk_accepted",
  "false_positive",
]);

const LIFECYCLE_ZERO: Record<FindingStatus, number> = {
  open: 0,
  accepted: 0,
  resolved: 0,
  reopened: 0,
  false_positive: 0,
  risk_accepted: 0,
  superseded: 0,
  stale_analysis: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function knownFactor(
  factor: Omit<DebtFactor, "state" | "points"> & { points: number },
): DebtFactor {
  return {
    ...factor,
    state: "known",
    points: clamp(factor.points, 0, factor.weight),
  };
}

function unknownFactor(
  factor: Omit<DebtFactor, "state" | "points" | "value" | "verifierClass"> & {
    value?: string;
  },
): DebtFactor {
  return {
    ...factor,
    state: "unknown",
    points: null,
    value: factor.value ?? "unknown",
    verifierClass: "unavailable",
  };
}

function severityPoints(severity: DebtFindingInput["severity"]): number {
  return { low: 5, medium: 12, high: 22, critical: 30 }[severity];
}

function recurrencePoints(occurrences: number): number {
  if (occurrences <= 1) return 0;
  if (occurrences === 2) return 5;
  if (occurrences <= 4) return 10;
  return 15;
}

function ageDays(firstSeenAt: string, now: string): number {
  const first = Date.parse(firstSeenAt);
  const current = Date.parse(now);
  if (!Number.isFinite(first) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.floor((current - first) / 86_400_000));
}

function agePoints(days: number): number {
  if (days <= 7) return 0;
  if (days <= 30) return 3;
  if (days <= 90) return 7;
  return 10;
}

function changePressure(
  input: DebtRankingContext,
): { points: number; value: string } | null {
  if (
    input.commitsWindow == null ||
    input.windowDays == null ||
    input.windowDays <= 0 ||
    input.commitsWindow < 0
  ) {
    return null;
  }
  const commitsPer30Days = (input.commitsWindow / input.windowDays) * 30;
  const points =
    commitsPer30Days === 0
      ? 0
      : commitsPer30Days <= 10
        ? 4
        : commitsPer30Days <= 40
          ? 9
          : 15;
  return { points, value: `${round(commitsPer30Days)} commits / 30d` };
}

function confidencePoints(status: DebtFindingInput["evidence_status"]): number {
  return { complete: 10, partial: 6, stale: 3, missing: 0, error: 0 }[status];
}

function remediationPoints(tier: number): number {
  return { 0: 3, 1: 2, 2: 1, 3: 0 }[clamp(Math.round(tier), 0, 3)] ?? 0;
}

function factorScore(
  factors: DebtFactor[],
  group?: DebtFactorGroup,
): {
  score: number;
  coveragePct: number;
  knownPoints: number;
  knownWeight: number;
} {
  const selected = group
    ? factors.filter((factor) => factor.group === group)
    : factors;
  const known = selected.filter((factor) => factor.state === "known");
  const knownPoints = known.reduce(
    (total, factor) => total + (factor.points ?? 0),
    0,
  );
  const knownWeight = known.reduce((total, factor) => total + factor.weight, 0);
  const totalWeight = selected.reduce(
    (total, factor) => total + factor.weight,
    0,
  );
  return {
    score: knownWeight === 0 ? 0 : round((knownPoints / knownWeight) * 100),
    coveragePct:
      totalWeight === 0 ? 0 : round((knownWeight / totalWeight) * 100),
    knownPoints,
    knownWeight,
  };
}

function effectiveLifecycle(
  finding: DebtFindingInput,
  now: string,
): {
  status: FindingStatus;
  decisionExpired: boolean;
  active: boolean;
} {
  const decisionExpired =
    DECISION_STATUSES.has(finding.status) &&
    finding.decision_expires_at != null &&
    Date.parse(finding.decision_expires_at) <= Date.parse(now);
  const status = decisionExpired
    ? finding.occurrence_count > 1
      ? "reopened"
      : "open"
    : finding.status;
  return {
    status,
    decisionExpired,
    active: status === "open" || status === "reopened",
  };
}

export function rankDebtFinding(
  finding: DebtFindingInput,
  context: DebtRankingContext,
): RankedDebtFinding {
  const days = ageDays(finding.first_seen_at, context.now);
  const pressure = changePressure(context);
  const factors: DebtFactor[] = [
    knownFactor({
      key: "severity",
      label: "Severity",
      group: "principal",
      weight: 30,
      points: severityPoints(finding.severity),
      value: finding.severity,
      explanation: "Inherent impact reported by the versioned scanner rubric.",
      provenance: `finding ${finding.check_id}`,
      verifierClass: "scanner",
    }),
    unknownFactor({
      key: "reachability",
      label: "Reachability",
      group: "principal",
      weight: 10,
      explanation:
        "Source paths and symbols are intentionally not stored in Team Brain.",
      provenance: "not admitted by the ledger contract",
    }),
    knownFactor({
      key: "recurrence",
      label: "Recurrence",
      group: "interest",
      weight: 15,
      points: recurrencePoints(finding.occurrence_count),
      value: `${finding.occurrence_count} observation${finding.occurrence_count === 1 ? "" : "s"}`,
      explanation: "Repeated observations increase the expected rework burden.",
      provenance: "durable finding ledger",
      verifierClass: "ledger",
    }),
    knownFactor({
      key: "age",
      label: "Age",
      group: "interest",
      weight: 10,
      points: agePoints(days),
      value: `${days}d`,
      explanation:
        "Unresolved debt accumulates interest as it survives more change cycles.",
      provenance: "first_seen_at",
      verifierClass: "ledger",
    }),
    pressure
      ? knownFactor({
          key: "change_pressure",
          label: "Change pressure",
          group: "interest",
          weight: 15,
          points: pressure.points,
          value: pressure.value,
          explanation:
            "Repository-level commit cadence raises the chance that active debt is touched.",
          provenance: "latest code_metrics commits_window/window_days",
          verifierClass: "repository",
        })
      : unknownFactor({
          key: "change_pressure",
          label: "Change pressure",
          group: "interest",
          weight: 15,
          explanation:
            "The latest scan did not contain a usable commit window.",
          provenance: "latest code_metrics unavailable",
        }),
    unknownFactor({
      key: "agent_friction",
      label: "Agent friction",
      group: "interest",
      weight: 5,
      explanation:
        "No finding-level rework or retry signal is admitted by the current contract.",
      provenance: "not yet measured",
    }),
    knownFactor({
      key: "evidence_confidence",
      label: "Evidence confidence",
      group: "confidence",
      weight: 10,
      points: confidencePoints(finding.evidence_status),
      value: finding.evidence_status,
      explanation:
        "Incomplete evidence reduces confidence without pretending the risk is absent.",
      provenance: "scanner evidence_status",
      verifierClass: "scanner",
    }),
    knownFactor({
      key: "remediation_cost",
      label: "Remediation affordability",
      group: "cost",
      weight: 3,
      points: remediationPoints(finding.remediation_tier),
      value: `tier ${finding.remediation_tier}`,
      explanation:
        "Lower remediation tiers receive a small priority lift; this is not a cost estimate.",
      provenance: "scanner remediation_tier",
      verifierClass: "scanner",
    }),
    unknownFactor({
      key: "review_cost",
      label: "Review cost",
      group: "cost",
      weight: 2,
      explanation:
        "No independently verified review-effort estimate exists for this finding.",
      provenance: "not yet measured",
    }),
  ];
  const total = factorScore(factors);
  const principal = factorScore(factors, "principal");
  const interest = factorScore(factors, "interest");
  const lifecycle = effectiveLifecycle(finding, context.now);
  return {
    findingId: finding.id,
    rank: 0,
    priorityScore: total.score,
    scoreCoveragePct: total.coveragePct,
    principalScore: principal.score,
    principalCoveragePct: principal.coveragePct,
    interestScore: interest.score,
    interestCoveragePct: interest.coveragePct,
    effectiveStatus: lifecycle.status,
    decisionExpired: lifecycle.decisionExpired,
    active: lifecycle.active,
    factors,
  };
}

function rankingComparator(
  findings: Map<string, DebtFindingInput>,
  left: RankedDebtFinding,
  right: RankedDebtFinding,
): number {
  const a = findings.get(left.findingId)!;
  const b = findings.get(right.findingId)!;
  return (
    right.priorityScore - left.priorityScore ||
    severityPoints(b.severity) - severityPoints(a.severity) ||
    b.occurrence_count - a.occurrence_count ||
    Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

function ageBucket(days: number): keyof DebtPatrolRollups["age"] {
  if (days <= 7) return "fresh";
  if (days <= 30) return "established";
  if (days <= 90) return "aging";
  return "entrenched";
}

export function buildDebtPatrol(
  findings: DebtFindingInput[],
  context: DebtRankingContext,
): DebtPatrol {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const allRankings = findings.map((finding) =>
    rankDebtFinding(finding, context),
  );
  const ranked = allRankings
    .filter((finding) => finding.active)
    .sort((a, b) => rankingComparator(byId, a, b))
    .map((finding, index) => ({ ...finding, rank: index + 1 }));

  const lifecycle = { ...LIFECYCLE_ZERO };
  const age: DebtPatrolRollups["age"] = {
    fresh: 0,
    established: 0,
    aging: 0,
    entrenched: 0,
  };
  const unknownFactors: Record<string, number> = {};
  for (const finding of findings) lifecycle[finding.status] += 1;
  for (const ranking of ranked) {
    const finding = byId.get(ranking.findingId)!;
    age[ageBucket(ageDays(finding.first_seen_at, context.now))] += 1;
    for (const factor of ranking.factors) {
      if (factor.state === "unknown")
        unknownFactors[factor.key] = (unknownFactors[factor.key] ?? 0) + 1;
    }
  }

  const meanCoveragePct =
    ranked.length === 0
      ? null
      : round(
          ranked.reduce(
            (total, finding) => total + finding.scoreCoveragePct,
            0,
          ) / ranked.length,
        );
  const highRisk = ranked.filter((ranking) => {
    const severity = byId.get(ranking.findingId)!.severity;
    return severity === "high" || severity === "critical";
  }).length;
  const meanInterest =
    ranked.length === 0
      ? null
      : round(
          ranked.reduce((total, finding) => total + finding.interestScore, 0) /
            ranked.length,
        );

  return {
    ranked,
    generatedAt: context.now,
    methodologyVersion: "1",
    rollups: {
      lifecycle,
      active: ranked.length,
      suppressed: findings.filter(
        (finding) =>
          DECISION_STATUSES.has(finding.status) &&
          !effectiveLifecycle(finding, context.now).decisionExpired,
      ).length,
      expired: allRankings.filter((finding) => finding.decisionExpired).length,
      recurring: ranked.filter(
        (ranking) => byId.get(ranking.findingId)!.occurrence_count > 1,
      ).length,
      evidenceUnknown: ranked.filter((ranking) => {
        const status = byId.get(ranking.findingId)!.evidence_status;
        return status !== "complete";
      }).length,
      age,
      admission: { scored: ranked.length, meanCoveragePct, unknownFactors },
      northStar: [
        {
          key: "change_risk",
          label: "Change risk",
          state: "proxy",
          value: highRisk,
          unit: "high/critical active findings",
          explanation:
            "A patrol proxy, not an independently verified outcome metric.",
        },
        {
          key: "agent_rework",
          label: "Agent rework",
          state: "unknown",
          value: null,
          unit: "unknown",
          explanation:
            "Retry and rework telemetry is not present in the ledger contract.",
        },
        {
          key: "reviewer_effort",
          label: "Reviewer effort",
          state: "unknown",
          value: null,
          unit: "unknown",
          explanation:
            "Verified review-time evidence remains in the engineering harness, not Team Brain.",
        },
        {
          key: "future_development_cost",
          label: "Future development cost",
          state: meanInterest == null ? "unknown" : "proxy",
          value: meanInterest,
          unit: meanInterest == null ? "unknown" : "mean interest index",
          explanation:
            meanInterest == null
              ? "No active admitted findings are available for an interest proxy."
              : "Age, recurrence, and repository change pressure only; not a currency estimate.",
        },
      ],
    },
  };
}
