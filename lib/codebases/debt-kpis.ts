import type { FindingStatus } from "@/lib/codebases/finding-ledger";
import {
  effectiveLifecycle,
  type DebtFindingInput,
} from "@/lib/codebases/debt-ranking";

const DAY_MS = 86_400_000;
const SUPPRESSED_STATUSES = new Set<FindingStatus>([
  "accepted",
  "risk_accepted",
  "false_positive",
]);

export const OPEN_AGE_BUCKETS = [
  "0_7d",
  "8_30d",
  "31_90d",
  "91d_plus",
] as const;
export type OpenAgeBucket = (typeof OPEN_AGE_BUCKETS)[number];

export const FIX_AGE_BUCKETS = [
  "0_1d",
  "2_7d",
  "8_30d",
  "31_90d",
  "91_365d",
  "366d_plus",
] as const;
export type FixAgeBucket = (typeof FIX_AGE_BUCKETS)[number];

export interface DebtKpiEvent {
  event_type: string;
  observed_at: string;
}

export interface DebtKpiFinding extends DebtFindingInput {
  events: DebtKpiEvent[];
}

export interface DebtMovementKpis {
  asOf: string;
  rangeStart: string;
  rangeEnd: string;
  actionable: number;
  actionableOpen: number;
  actionableReopened: number;
  suppressed: number;
  suppressions: {
    accepted: number;
    riskAccepted: number;
    falsePositive: number;
  };
  totalKnownActive: number;
  arrivals: number;
  detected: number;
  reopened: number;
  closures: number;
  netFlow: number;
  expiryReturnsToActionable: number;
  expiryFlowAvailable: false;
  openAge: Record<OpenAgeBucket, number> & { unknown: number };
  severity: Record<DebtKpiFinding["severity"], number>;
  recurrence: {
    reopened: number;
    eligibleResolvedFindings: number;
    ratePct: number | null;
  };
}

export type CommitClassification = "fix" | "feat" | "other" | "unparseable";

export interface CommitObservation {
  committed_at?: unknown;
  commit_classification?: {
    scheme?: unknown;
    type?: unknown;
  };
  fix_analysis?: {
    method?: unknown;
    candidate_parent_lines?: unknown;
    blamed_parent_lines?: unknown;
    age_buckets?: unknown;
    prior_fix_parent_lines?: unknown;
  };
}

export interface CommitDebtKpis {
  observedCommits: number;
  commitsWindow: number | null;
  scannerWindowDays: number | null;
  feedCoveragePct: number | null;
  classifiedCommits: number;
  classificationCoveragePct: number | null;
  classes: Record<CommitClassification, number>;
  fixSharePct: number | null;
  fixAnalysisCommits: number;
  fixCommits: number;
  fixAnalysisCoveragePct: number | null;
  candidateParentLines: number;
  blamedParentLines: number;
  blameCoveragePct: number | null;
  fixAge: Record<FixAgeBucket, number>;
  priorFixParentLines: number;
  fixOnFixPct: number | null;
}

export interface CodebaseDebtKpis {
  movement: DebtMovementKpis;
  commits: CommitDebtKpis;
}

function finiteDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inRange(value: string, startMs: number, endMs: number): boolean {
  const parsed = finiteDate(value);
  return parsed != null && parsed >= startMs && parsed <= endMs;
}

function openAgeBucket(days: number): OpenAgeBucket {
  if (days <= 7) return "0_7d";
  if (days <= 30) return "8_30d";
  if (days <= 90) return "31_90d";
  return "91d_plus";
}

function latestActionableStart(
  finding: DebtKpiFinding,
  asOfMs: number,
  decisionExpired: boolean,
): number | null {
  if (decisionExpired && finding.decision_expires_at) {
    const expiresAt = finiteDate(finding.decision_expires_at);
    if (expiresAt != null && expiresAt <= asOfMs) return expiresAt;
  }

  let latest: number | null = null;
  for (const event of finding.events) {
    if (event.event_type !== "detected" && event.event_type !== "reopened")
      continue;
    const observedAt = finiteDate(event.observed_at);
    if (observedAt == null || observedAt > asOfMs) continue;
    if (latest == null || observedAt > latest) latest = observedAt;
  }
  return latest;
}

export function deriveDebtMovementKpis(
  findings: DebtKpiFinding[],
  input: { rangeStart: string; rangeEnd: string; asOf?: string },
): DebtMovementKpis {
  const rangeStartMs = finiteDate(input.rangeStart);
  const rangeEndMs = finiteDate(input.rangeEnd);
  const asOf = input.asOf ?? input.rangeEnd;
  const asOfMs = finiteDate(asOf);
  if (
    rangeStartMs == null ||
    rangeEndMs == null ||
    asOfMs == null ||
    rangeStartMs > rangeEndMs
  ) {
    throw new Error("debt KPI range must contain valid ordered timestamps");
  }

  const result: DebtMovementKpis = {
    asOf,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    actionable: 0,
    actionableOpen: 0,
    actionableReopened: 0,
    suppressed: 0,
    suppressions: { accepted: 0, riskAccepted: 0, falsePositive: 0 },
    totalKnownActive: 0,
    arrivals: 0,
    detected: 0,
    reopened: 0,
    closures: 0,
    netFlow: 0,
    expiryReturnsToActionable: 0,
    expiryFlowAvailable: false,
    openAge: { "0_7d": 0, "8_30d": 0, "31_90d": 0, "91d_plus": 0, unknown: 0 },
    severity: { low: 0, medium: 0, high: 0, critical: 0 },
    recurrence: { reopened: 0, eligibleResolvedFindings: 0, ratePct: null },
  };

  const resolvedEligible = new Set<string>();
  for (const finding of findings) {
    const lifecycle = effectiveLifecycle(finding, asOf);
    if (lifecycle.active) {
      result.actionable += 1;
      if (lifecycle.status === "reopened") result.actionableReopened += 1;
      else result.actionableOpen += 1;
      result.severity[finding.severity] += 1;
      if (lifecycle.decisionExpired) result.expiryReturnsToActionable += 1;

      const actionableSince = latestActionableStart(
        finding,
        asOfMs,
        lifecycle.decisionExpired,
      );
      if (actionableSince == null) result.openAge.unknown += 1;
      else {
        const days = Math.max(
          0,
          Math.floor((asOfMs - actionableSince) / DAY_MS),
        );
        result.openAge[openAgeBucket(days)] += 1;
      }
    } else if (SUPPRESSED_STATUSES.has(lifecycle.status)) {
      result.suppressed += 1;
      if (lifecycle.status === "accepted") result.suppressions.accepted += 1;
      if (lifecycle.status === "risk_accepted")
        result.suppressions.riskAccepted += 1;
      if (lifecycle.status === "false_positive")
        result.suppressions.falsePositive += 1;
    }

    for (const event of finding.events) {
      const eventMs = finiteDate(event.observed_at);
      if (
        event.event_type === "resolved" &&
        eventMs != null &&
        eventMs <= rangeEndMs
      ) {
        resolvedEligible.add(finding.id);
      }
      if (!inRange(event.observed_at, rangeStartMs, rangeEndMs)) continue;
      if (event.event_type === "detected") result.detected += 1;
      if (event.event_type === "reopened") result.reopened += 1;
      if (event.event_type === "resolved") result.closures += 1;
    }
  }

  result.arrivals = result.detected + result.reopened;
  result.netFlow = result.arrivals - result.closures;
  result.totalKnownActive = result.actionable + result.suppressed;
  result.recurrence = {
    reopened: result.reopened,
    eligibleResolvedFindings: resolvedEligible.size,
    ratePct:
      resolvedEligible.size === 0
        ? null
        : Math.round((result.reopened / resolvedEligible.size) * 10_000) / 100,
  };
  return result;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function commitClass(commit: CommitObservation): CommitClassification | null {
  if (commit.commit_classification?.scheme !== "conventional-commit-v1")
    return null;
  const value = commit.commit_classification.type;
  return value === "fix" ||
    value === "feat" ||
    value === "other" ||
    value === "unparseable"
    ? value
    : null;
}

export function deriveCommitDebtKpis(
  commits: CommitObservation[],
  input: { commitsWindow: number | null; scannerWindowDays: number | null },
): CommitDebtKpis {
  const classes: Record<CommitClassification, number> = {
    fix: 0,
    feat: 0,
    other: 0,
    unparseable: 0,
  };
  const fixAge: Record<FixAgeBucket, number> = {
    "0_1d": 0,
    "2_7d": 0,
    "8_30d": 0,
    "31_90d": 0,
    "91_365d": 0,
    "366d_plus": 0,
  };
  let classifiedCommits = 0;
  let fixAnalysisCommits = 0;
  let candidateParentLines = 0;
  let blamedParentLines = 0;
  let priorFixParentLines = 0;

  for (const commit of commits) {
    const type = commitClass(commit);
    if (type == null) continue;
    classifiedCommits += 1;
    classes[type] += 1;
    if (
      type !== "fix" ||
      commit.fix_analysis?.method !== "first-parent-line-blame-v1"
    )
      continue;

    const candidate = nonnegativeInteger(
      commit.fix_analysis.candidate_parent_lines,
    );
    const blamed = nonnegativeInteger(commit.fix_analysis.blamed_parent_lines);
    const priorFix = nonnegativeInteger(
      commit.fix_analysis.prior_fix_parent_lines,
    );
    const buckets = commit.fix_analysis.age_buckets;
    if (
      candidate == null ||
      blamed == null ||
      priorFix == null ||
      buckets == null
    )
      continue;
    if (typeof buckets !== "object" || Array.isArray(buckets)) continue;
    const values = FIX_AGE_BUCKETS.map((bucket) =>
      nonnegativeInteger((buckets as Record<string, unknown>)[bucket]),
    );
    if (values.some((value) => value == null)) continue;
    const bucketTotal = values.reduce<number>(
      (total, value) => total + (value ?? 0),
      0,
    );
    if (bucketTotal !== blamed || blamed > candidate || priorFix > blamed)
      continue;

    fixAnalysisCommits += 1;
    candidateParentLines += candidate;
    blamedParentLines += blamed;
    priorFixParentLines += priorFix;
    FIX_AGE_BUCKETS.forEach((bucket, index) => {
      fixAge[bucket] += values[index] ?? 0;
    });
  }

  const observedCommits = commits.length;
  const parseableCommits = classes.fix + classes.feat + classes.other;
  const fixFeat = classes.fix + classes.feat;
  return {
    observedCommits,
    commitsWindow: input.commitsWindow,
    scannerWindowDays: input.scannerWindowDays,
    feedCoveragePct:
      input.commitsWindow == null || input.commitsWindow === 0
        ? null
        : Math.round(
            Math.min(1, observedCommits / input.commitsWindow) * 10_000,
          ) / 100,
    classifiedCommits,
    classificationCoveragePct:
      observedCommits === 0
        ? null
        : Math.round((parseableCommits / observedCommits) * 10_000) / 100,
    classes,
    fixSharePct:
      fixFeat === 0 ? null : Math.round((classes.fix / fixFeat) * 10_000) / 100,
    fixAnalysisCommits,
    fixCommits: classes.fix,
    fixAnalysisCoveragePct:
      classes.fix === 0
        ? null
        : Math.round((fixAnalysisCommits / classes.fix) * 10_000) / 100,
    candidateParentLines,
    blamedParentLines,
    blameCoveragePct:
      candidateParentLines === 0
        ? null
        : Math.round((blamedParentLines / candidateParentLines) * 10_000) / 100,
    fixAge,
    priorFixParentLines,
    fixOnFixPct:
      blamedParentLines === 0
        ? null
        : Math.round((priorFixParentLines / blamedParentLines) * 10_000) / 100,
  };
}

export function deriveCodebaseDebtKpis(input: {
  findings: DebtKpiFinding[];
  commits: CommitObservation[];
  rangeStart: string;
  rangeEnd: string;
  asOf?: string;
  commitsWindow: number | null;
  scannerWindowDays: number | null;
}): CodebaseDebtKpis {
  return {
    movement: deriveDebtMovementKpis(input.findings, input),
    commits: deriveCommitDebtKpis(input.commits, input),
  };
}
