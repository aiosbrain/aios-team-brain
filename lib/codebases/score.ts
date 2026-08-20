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
  /**
   * The DENOMINATOR `test_coverage_pct` was measured over: instrumented lines the coverage
   * report actually looked at. null = unknown (a pre-1.22 row, or a scanner that doesn't send
   * it) — NOT zero, and not "the whole repo".
   */
  test_coverage_lines_total: number | null;
  /** Of `test_coverage_lines_total`, how many were hit. null = unknown. */
  test_coverage_lines_covered: number | null;
  /** Test-run integrity counts. null = no test-result report; NOT "nothing was skipped". */
  tests_total: number | null;
  tests_passed: number | null;
  tests_skipped: number | null;
  tests_failed: number | null;
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

/**
 * The brain-derived columns of a `code_metrics` row. `lib/codebases/ingest.ts` spreads this
 * object straight into the upsert, so **every key here must be a column on `code_metrics`** —
 * a derived value with no column (e.g. the partial-run flag, which the read layer computes from
 * the raw `tests_*` counts via {@link scanPartial}) belongs outside this interface.
 */
export interface ComputedScores {
  agentic_score: number;
  health_score: number;
  ai_commit_ratio: number;
  /** null = the repo filed no coverage report; NOT the same as a measured 0%. */
  test_coverage_score: number | null;
  /**
   * How much of the repository the coverage percentage speaks for: instrumented lines as a
   * share of counted lines, 0–100. null = the denominator is unknown, which is the state of
   * every row written before brain-api 1.22. NOT folded into any composite — see
   * `coverageBreadthPct` for why.
   */
  coverage_breadth_pct: number | null;
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
 * How much of the repository `test_coverage_pct` actually speaks for: instrumented lines as a
 * share of counted lines (`loc`), 0–100. Returns **null** when either side is unknown.
 *
 * This is the second iteration of the bug the comment above records. That one was *absence*
 * treated as zero; this one is *presence* treated as completeness. A percentage with no
 * denominator is not a measurement of a repository — it is a measurement of whatever the runner
 * happened to instrument, and coverage carries 40% of `health_score` and 25% of `agentic_score`,
 * so a repo that measures 436 lines and one that measures 10,647 land in the same place. Measured
 * on this fleet the spread is not marginal: aios-team-brain reports 40.21% over 9,752 instrumented
 * lines of 194,340 counted — a headline number describing 5% of the repo — while aios-workspace
 * reports 85.66% over 67,655 of 169,002, or 40%. Presence of a number is not evidence of coverage.
 *
 * Clamped at 100 because the two counts come from different censuses and the ratio is only
 * approximate: `loc` counts tracked files with a known code extension under 1 MB, while a coverage
 * runner instruments whatever its config globs — which can include generated files, a `.vue`/`.mts`
 * extension `loc` doesn't count, or a vendored directory. Breadth is a scope indicator, not an
 * accounting identity, and a ratio above 1 means the two censuses disagree, not that the repo is
 * over-covered.
 *
 * **It is deliberately NOT folded into `coverageScore` or either composite.** Not because breadth
 * is uninteresting — it is the missing denominator, and weighting coverage by it is the obvious
 * next move — but because at the moment this ships, EVERY row in `code_metrics` has a null
 * denominator and only re-scanned repos will acquire one. A factor applied the day the column
 * lands would rank re-scanned repos against un-rescanned ones under two different formulas, which
 * makes the leaderboard less comparable than the flaw it set out to fix, and it would move scores
 * for reasons no one could attribute to a code change. So: measure first, publish the number in
 * the UI (`components/codebases/`), let one full scan cycle populate the fleet, and calibrate the
 * factor against real observed breadth rather than a guess. The recommendation on the table is to
 * scale coverage's *weight* by breadth rather than its *value* — a narrow measurement should carry
 * proportionally less of the composite and let the components that did report take up the slack,
 * which is exactly what {@link weightedScore} already does for a null. Scaling the value instead
 * would punish narrow coverage as though it were bad coverage, which is a different claim and one
 * this data does not support.
 */
export function coverageBreadthPct(i: ScanInputs): number | null {
  const instrumented = i.test_coverage_lines_total;
  if (instrumented == null || i.loc <= 0) return null;
  return clamp((100 * instrumented) / i.loc);
}

/**
 * The counts a test-result report yields. A narrow input (not the full {@link ScanInputs}) so the
 * read paths in `lib/metrics/codebases.ts` can call {@link scanPartial} on a `code_metrics` row
 * directly, instead of re-deriving the rule and letting the two drift.
 */
export interface RunIntegrity {
  tests_total: number | null;
  tests_skipped: number | null;
  tests_failed: number | null;
}

/**
 * Whether the run behind `test_coverage_pct` is known to have been incomplete.
 *
 * `null` = no test-result report, so completeness is UNKNOWN — which is emphatically not the same
 * as "nothing was skipped". Absence of evidence, again.
 *
 * Skips are not failures and a skipped suite is not a broken one, so this never touches a score;
 * it exists so the number can be read with its caveat attached. The failure it is built for is
 * silent: on aios-devtools a single unset `AIOS_TOOLKIT_DIR` skipped 91 of 229 tests by design and
 * moved coverage 29 points (48.93% → 77.68%) with nothing going red, and on aios-workspace-gui the
 * same variable produced 27 failures plus 58 skips — a run that would have reported "no coverage"
 * while every gate stayed green. A degraded run has to announce itself, because a half-run suite
 * emits a perfectly plausible percentage.
 */
export function scanPartial(i: RunIntegrity): boolean | null {
  // Positive evidence first: a reported skip or failure makes the run partial no matter what
  // else is missing. Knowing 91 cases were skipped is enough, even if the total never arrived.
  if ((i.tests_skipped ?? 0) > 0 || (i.tests_failed ?? 0) > 0) return true;
  // `false` is the strong claim "this run was complete", so it needs the evidence to say it:
  // BOTH counts explicitly reported as zero. Defaulting a null to 0 here and returning false
  // would let the UI print "none skipped" on the strength of a field that was never sent —
  // the same null-is-not-zero mistake this whole change exists to stop, one layer down.
  if (i.tests_total == null || i.tests_skipped == null || i.tests_failed == null) return null;
  return false;
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
  // Derived and reported, NOT weighted — see coverageBreadthPct's comment for why the factor
  // is held back. Two repos with the same `test_coverage_pct` and different denominators are
  // distinguishable in this output; they are still, for now, identical in the composites.
  const coverage_breadth_pct = coverageBreadthPct(i);
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
    coverage_breadth_pct: coverage_breadth_pct == null ? null : round(coverage_breadth_pct),
    scaffolding_score: round(scaffolding_score),
    skill_breadth_score: round(skill_breadth_score),
    cadence_score: round(cadence_score),
    issue_health: round(issue_health),
  };
}
