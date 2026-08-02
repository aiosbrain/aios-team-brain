/**
 * Codebase scoring — computed in the brain at ingest from RAW scanner metrics
 * (one TS implementation, unit-tested). The scanner sends raw facts; the brain derives
 * the scores here. The lone exception is AEM agent-readiness, which the scanner scores
 * against the rubric (its checks are filesystem questions the brain can't see) and the
 * brain persists verbatim — see lib/metrics/codebases.ts and docs/ARCHITECTURE.md.
 *
 * The "agentic score" is a PROVISIONAL, tunable heuristic for how AI-native a
 * codebase is. The `Co-Authored-By: Claude` commit trailer proves a commit was
 * AI-*assisted*, not that exact lines were AI-written, and it saturates fast
 * (nearly every commit may carry it) — so `ai_commit_ratio` is the LOWEST weight,
 * not the backbone. Harder signals (coverage, agent-native scaffolding, skill
 * breadth) carry the score. Every sub-score is 0–100 and maps to explicit named
 * inputs so this stays testable. Weights live here and are meant to be tuned.
 */

import { clamp, round } from "@/lib/num";

export const AGENTIC_WEIGHTS = {
  ai_commit_ratio: 0.15,
  test_coverage_score: 0.25,
  scaffolding_score: 0.25,
  skill_breadth_score: 0.2,
  cadence_score: 0.15,
} as const;

export const HEALTH_WEIGHTS = {
  test_coverage_score: 0.4,
  cadence_score: 0.3,
  issue_health: 0.3,
} as const;

/** Raw measures the scanner pushes; the brain derives scores from these. */
export interface ScanInputs {
  commits_window: number;
  ai_commits_window: number;
  test_coverage_pct: number | null; // null = no coverage report found
  // scaffolding (named, not vague JSON)
  has_claude_md: boolean;
  has_agents_md: boolean;
  agents_md_count: number;
  skills_count: number;
  commands_count: number;
  // cadence inputs
  active_days: number; // distinct commit days in the window
  window_days: number;
  days_since_last_commit: number | null;
  // issue-health inputs
  open_issues: number;
  loc: number;
}

export interface ComputedScores {
  agentic_score: number;
  health_score: number;
  ai_commit_ratio: number;
  /** null = the repo filed no coverage report; NOT the same as a measured 0%. */
  test_coverage_score: number | null;
  scaffolding_score: number;
  skill_breadth_score: number;
  cadence_score: number;
  issue_health: number;
}

/** % of commits in the window that are AI-coauthored (heuristic; can saturate). */
export function aiCommitRatio(i: ScanInputs): number {
  return clamp((100 * i.ai_commits_window) / Math.max(i.commits_window, 1));
}

/**
 * Coverage normalized so 80% → 100. Returns **null** when the repo filed no coverage report.
 *
 * It previously returned 0 for null, with a comment promising it was "surfaced as 'no report'
 * in UI". That held for the aggregate tile, but not for the composites: a repo that has never
 * reported coverage scored identically to a repo measured at 0%, and since coverage carries
 * 40% of health_score and 25% of agentic_score, "we don't know" cost up to 40 points of health.
 *
 * That is not a hypothetical. A scaffolded workspace is a content repo with no test suite, and
 * `coverage/` is gitignored so no clone can ever supply one — so EVERY workspace sat at a
 * permanent 40-point health penalty for a test suite it was never supposed to have.
 *
 * Null now propagates, and `computeScores` renormalizes over the components that actually
 * reported. Absence of evidence is not evidence of zero.
 */
export function coverageScore(i: ScanInputs): number | null {
  if (i.test_coverage_pct == null) return null;
  return clamp((i.test_coverage_pct / 80) * 100);
}

/**
 * Weighted mean over the components that reported, renormalized by their weights. A null
 * component is EXCLUDED, not counted as zero — so dropping an unmeasurable signal leaves the
 * remaining ones at full relative strength rather than silently capping the total.
 */
export function weightedScore(parts: Array<{ weight: number; value: number | null }>): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const { weight, value } of parts) {
    if (value == null) continue;
    weighted += weight * value;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

/** Presence of agent-native scaffolding (CLAUDE.md / AGENTS.md). */
export function scaffoldingScore(i: ScanInputs): number {
  return clamp(
    (i.has_claude_md ? 40 : 0) + (i.has_agents_md ? 40 : 0) + Math.min(20, i.agents_md_count * 10)
  );
}

/** Depth of the .claude harness (skills + commands). 10 skills → full marks. */
export function skillBreadthScore(i: ScanInputs): number {
  return clamp(i.skills_count * 10 + i.commands_count * 5);
}

/** Sustained recent activity, attenuated by staleness. */
export function cadenceScore(i: ScanInputs): number {
  const activity = Math.min(1, i.active_days / Math.max(i.window_days * 0.25, 1));
  const d = i.days_since_last_commit;
  // freshness is a 0–1 factor: full within a week, decaying with staleness.
  const freshness = d == null ? 0 : d <= 7 ? 1 : Math.min(1, 14 / d);
  return clamp(100 * activity * (0.5 + 0.5 * freshness));
}

/** Open-issue load relative to repo size (smaller load → healthier). */
export function issueHealth(i: ScanInputs): number {
  const capacity = Math.max(i.loc / 2000, 10);
  return clamp(100 * (1 - Math.min(1, i.open_issues / capacity)));
}

export function computeScores(i: ScanInputs): ComputedScores {
  const ai_commit_ratio = aiCommitRatio(i);
  const test_coverage_score = coverageScore(i);
  const scaffolding_score = scaffoldingScore(i);
  const skill_breadth_score = skillBreadthScore(i);
  const cadence_score = cadenceScore(i);
  const issue_health = issueHealth(i);

  // Renormalized over reported components — an unmeasured signal is dropped from the mean,
  // never folded in as a zero. With coverage present both formulas are arithmetically
  // identical to the previous straight weighted sum (the weights each total 1.0).
  const agentic_score = weightedScore([
    { weight: AGENTIC_WEIGHTS.ai_commit_ratio, value: ai_commit_ratio },
    { weight: AGENTIC_WEIGHTS.test_coverage_score, value: test_coverage_score },
    { weight: AGENTIC_WEIGHTS.scaffolding_score, value: scaffolding_score },
    { weight: AGENTIC_WEIGHTS.skill_breadth_score, value: skill_breadth_score },
    { weight: AGENTIC_WEIGHTS.cadence_score, value: cadence_score },
  ]);

  const health_score = weightedScore([
    { weight: HEALTH_WEIGHTS.test_coverage_score, value: test_coverage_score },
    { weight: HEALTH_WEIGHTS.cadence_score, value: cadence_score },
    { weight: HEALTH_WEIGHTS.issue_health, value: issue_health },
  ]);

  return {
    agentic_score: round(agentic_score),
    health_score: round(health_score),
    ai_commit_ratio: round(ai_commit_ratio),
    test_coverage_score: test_coverage_score == null ? null : round(test_coverage_score),
    scaffolding_score: round(scaffolding_score),
    skill_breadth_score: round(skill_breadth_score),
    cadence_score: round(cadence_score),
    issue_health: round(issue_health),
  };
}
