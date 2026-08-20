import { describe, expect, it } from "vitest";
import {
  computeScores,
  coverageScore,
  coverageBreadthPct,
  isUnscopedCoverage,
  scanPartial,
  aiCommitRatio,
  scaffoldingScore,
  skillBreadthScore,
  cadenceScore,
  issueHealth,
  type ScanInputs,
} from "./score";

// Spec-first: assertions are derived from the intended formula/weights, not from
// reading the implementation. If a weight changes, these go red on purpose.

const FULLY_AGENTIC: ScanInputs = {
  commits_window: 100,
  ai_commits_window: 90, // → ai_commit_ratio 90
  test_coverage_pct: 80, // → coverage_score 100
  // brain-api 1.22 (AIO-995): the denominator, and the integrity of the run behind it.
  // 40,000 instrumented of 50,000 loc → breadth 80.
  test_coverage_lines_total: 40_000,
  test_coverage_lines_covered: 32_000,
  tests_total: 200,
  tests_passed: 200,
  tests_skipped: 0,
  tests_failed: 0,
  has_claude_md: true,
  has_agents_md: true,
  agents_md_count: 2, // → scaffolding 40+40+20 = 100
  skills_count: 10,
  commands_count: 0, // → skill_breadth 100
  active_days: 23, // window*0.25 = 22.5 → activity 1
  window_days: 90,
  days_since_last_commit: 1, // → freshness 1 → cadence 100
  open_issues: 0,
  loc: 50_000, // → issue_health 100
};

describe("sub-scores", () => {
  it("coverage: no report → null; 0% → 0; 80% → 100; 40% → 50", () => {
    // null and 0 are different facts: "never measured" vs "measured, covers nothing".
    expect(coverageScore({ ...FULLY_AGENTIC, test_coverage_pct: null })).toBeNull();
    expect(coverageScore({ ...FULLY_AGENTIC, test_coverage_pct: 0 })).toBe(0);
    expect(coverageScore({ ...FULLY_AGENTIC, test_coverage_pct: 80 })).toBe(100);
    expect(coverageScore({ ...FULLY_AGENTIC, test_coverage_pct: 40 })).toBe(50);
  });

  it("ai_commit_ratio is a ratio that saturates (90/100 → 90, 100/100 → 100)", () => {
    expect(aiCommitRatio({ ...FULLY_AGENTIC, ai_commits_window: 90 })).toBe(90);
    expect(aiCommitRatio({ ...FULLY_AGENTIC, ai_commits_window: 100 })).toBe(100);
    expect(aiCommitRatio({ ...FULLY_AGENTIC, commits_window: 0, ai_commits_window: 0 })).toBe(0);
  });

  it("scaffolding: both md files + 2 AGENTS.md → 100; only CLAUDE.md → 40", () => {
    expect(scaffoldingScore(FULLY_AGENTIC)).toBe(100);
    expect(
      scaffoldingScore({ ...FULLY_AGENTIC, has_agents_md: false, agents_md_count: 0 })
    ).toBe(40);
  });

  it("skill breadth: 10 skills → 100; caps at 100", () => {
    expect(skillBreadthScore({ ...FULLY_AGENTIC, skills_count: 10, commands_count: 0 })).toBe(100);
    expect(skillBreadthScore({ ...FULLY_AGENTIC, skills_count: 50, commands_count: 9 })).toBe(100);
  });

  it("cadence: stale repo decays toward zero", () => {
    expect(cadenceScore(FULLY_AGENTIC)).toBe(100);
    const stale = cadenceScore({ ...FULLY_AGENTIC, days_since_last_commit: 140 });
    expect(stale).toBeGreaterThan(0);
    expect(stale).toBeLessThan(60);
    expect(cadenceScore({ ...FULLY_AGENTIC, active_days: 0, days_since_last_commit: null })).toBe(0);
  });

  it("issue_health: zero issues → 100; heavy load → 0", () => {
    expect(issueHealth(FULLY_AGENTIC)).toBe(100);
    expect(issueHealth({ ...FULLY_AGENTIC, open_issues: 1000, loc: 1000 })).toBe(0);
  });
});

describe("composite scores (weights locked)", () => {
  it("a maximally agentic repo scores 98.5 agentic / 100 health", () => {
    const s = computeScores(FULLY_AGENTIC);
    // 0.15*90 + 0.25*100 + 0.25*100 + 0.20*100 + 0.15*100 = 98.5
    expect(s.agentic_score).toBe(98.5);
    expect(s.health_score).toBe(100);
  });

  it("a MEASURED 0% coverage lowers both scores (coverage carries weight)", () => {
    const withCov = computeScores(FULLY_AGENTIC);
    const zeroCov = computeScores({ ...FULLY_AGENTIC, test_coverage_pct: 0 });
    // agentic loses 0.25*100 = 25; health loses 0.4*100 = 40
    expect(zeroCov.agentic_score).toBe(withCov.agentic_score - 25);
    expect(zeroCov.health_score).toBe(withCov.health_score - 40);
    expect(zeroCov.test_coverage_score).toBe(0);
  });

  it("NO coverage report is excluded from the composites, not scored as zero", () => {
    // The regression that lets this recur: a repo that never filed a report used to score
    // identically to a repo measured at 0%. Coverage is 40% of health, so every scaffolded
    // workspace — a content repo with no suite, and `coverage/` gitignored so no clone can
    // ever supply one — sat at a permanent 40-point penalty and showed as a false 0%.
    const noCov = computeScores({ ...FULLY_AGENTIC, test_coverage_pct: null });
    const zeroCov = computeScores({ ...FULLY_AGENTIC, test_coverage_pct: 0 });

    expect(noCov.test_coverage_score).toBeNull();
    expect(noCov.agentic_score).not.toBe(zeroCov.agentic_score);
    expect(noCov.health_score).not.toBe(zeroCov.health_score);

    // Renormalized over the components that DID report: the other four agentic weights total
    // 0.75, and this fixture scores 100 on all of them except ai_commit_ratio (90).
    // (0.15*90 + 0.25*100 + 0.20*100 + 0.15*100) / 0.75 = 98
    expect(noCov.agentic_score).toBe(98);
    // health: cadence + issue_health both 100, renormalized over 0.6 → 100
    expect(noCov.health_score).toBe(100);
  });

  it("an unmeasured signal never drags a composite below its measured peers", () => {
    // The invariant behind the fix, stated independently of the fixture's numbers.
    const noCov = computeScores({ ...FULLY_AGENTIC, test_coverage_pct: null });
    const zeroCov = computeScores({ ...FULLY_AGENTIC, test_coverage_pct: 0 });
    expect(noCov.health_score).toBeGreaterThan(zeroCov.health_score);
    expect(noCov.agentic_score).toBeGreaterThan(zeroCov.agentic_score);
  });

  it("the AI-commit trailer is a low-weight signal, not the backbone", () => {
    // Halving AI commits (90→45) drops agentic by only 0.15*45 = 6.75.
    const base = computeScores(FULLY_AGENTIC);
    const halfAi = computeScores({ ...FULLY_AGENTIC, ai_commits_window: 45 });
    expect(base.agentic_score - halfAi.agentic_score).toBeCloseTo(6.75, 5);
  });
});

describe("coverage denominator (brain-api 1.22 / AIO-995)", () => {
  // Two repos, ONE reported number. The narrow one measured 436 lines of a 3,140-line repo;
  // the broad one measured 10,647 of 11,000. Before 1.22 the payload could not tell them apart,
  // so nothing downstream could either — and coverage carries 40% of health_score.
  const NARROW: ScanInputs = {
    ...FULLY_AGENTIC,
    test_coverage_pct: 99,
    test_coverage_lines_total: 436,
    test_coverage_lines_covered: 432,
    loc: 3_140,
  };
  const BROAD: ScanInputs = {
    ...FULLY_AGENTIC,
    test_coverage_pct: 99,
    test_coverage_lines_total: 10_647,
    test_coverage_lines_covered: 10_540,
    loc: 11_000,
  };

  it("identical coverage % over different denominators is DISTINGUISHABLE in the output", () => {
    const narrow = computeScores(NARROW);
    const broad = computeScores(BROAD);

    // Same percentage, therefore the same coverage sub-score — that part is honest.
    expect(narrow.test_coverage_score).toBe(broad.test_coverage_score);

    // …but the scope is no longer invisible. This is the assertion the issue exists for.
    expect(narrow.coverage_breadth_pct).not.toBe(broad.coverage_breadth_pct);
    expect(narrow.coverage_breadth_pct).toBe(13.89); // 436 / 3,140
    expect(broad.coverage_breadth_pct).toBe(96.79); // 10,647 / 11,000
  });

  it("breadth is a ratio of instrumented lines to counted lines, clamped at 100", () => {
    expect(coverageBreadthPct({ ...FULLY_AGENTIC, test_coverage_lines_total: 5_000, loc: 10_000 })).toBe(50);
    // The two censuses disagree (a runner instruments files `loc` doesn't count). That is a
    // disagreement, not 130% coverage.
    expect(coverageBreadthPct({ ...FULLY_AGENTIC, test_coverage_lines_total: 13_000, loc: 10_000 })).toBe(100);
    // A repo with no counted lines has no denominator to divide by.
    expect(coverageBreadthPct({ ...FULLY_AGENTIC, test_coverage_lines_total: 100, loc: 0 })).toBeNull();
  });

  it("a MEASURED zero-breadth scan is not the same fact as an unknown denominator", () => {
    // Symmetric with the null-coverage rule above: 0 instrumented lines is a measurement
    // ("the runner looked at nothing"); a missing denominator is an absence of one.
    expect(coverageBreadthPct({ ...FULLY_AGENTIC, test_coverage_lines_total: 0 })).toBe(0);
    expect(coverageBreadthPct({ ...FULLY_AGENTIC, test_coverage_lines_total: null })).toBeNull();
  });

  it("BACKWARD COMPAT: a pre-1.22 row with no denominator scores EXACTLY as it does today", () => {
    // Every row already in code_metrics has null for all six new fields and can never acquire
    // them. Its composites must not move by a single point when this ships — the new signal is
    // reported, never weighted.
    const legacy: ScanInputs = {
      ...FULLY_AGENTIC,
      test_coverage_lines_total: null,
      test_coverage_lines_covered: null,
      tests_total: null,
      tests_passed: null,
      tests_skipped: null,
      tests_failed: null,
    };
    const s = computeScores(legacy);

    // The exact numbers the "weights locked" test above pins for this fixture, restated here so
    // this test fails on its own terms rather than by borrowing another test's constant.
    expect(s.agentic_score).toBe(98.5);
    expect(s.health_score).toBe(100);
    expect(s.test_coverage_score).toBe(100);

    // Unknown scope reads as unknown — never as zero coverage, never as full coverage.
    expect(s.coverage_breadth_pct).toBeNull();
  });

  it("breadth does NOT move a composite — it is disclosed, not weighted (yet)", () => {
    // Deliberate, and the thing to change when the factor is calibrated. Stated as a test so
    // wiring breadth into the score can never happen silently.
    const narrow = computeScores(NARROW);
    const sameButBlind = computeScores({ ...NARROW, test_coverage_lines_total: null });
    expect(narrow.agentic_score).toBe(sameButBlind.agentic_score);
    expect(narrow.health_score).toBe(sameButBlind.health_score);
  });
});

describe("test-run integrity (brain-api 1.22 / AIO-995)", () => {
  it("no test-result report → completeness UNKNOWN, not 'nothing was skipped'", () => {
    expect(scanPartial({ tests_total: null, tests_skipped: null, tests_failed: null })).toBeNull();
    // A report that names its skips as zero is a different, stronger claim.
    expect(scanPartial({ tests_total: 200, tests_skipped: 0, tests_failed: 0 })).toBe(false);
  });

  it("a total WITHOUT skip/fail counts is still unknown — `false` needs evidence", () => {
    // The regression this pins: defaulting a null count to 0 returned `false`, and the UI
    // rendered "N tests, none skipped" — a positive claim built on a field nobody sent. A
    // Vitest/Jest report carrying `numTotalTests` but no `numPendingTests` produces exactly
    // this shape. Absence of evidence is not evidence of zero, one layer down.
    expect(scanPartial({ tests_total: 200, tests_skipped: null, tests_failed: null })).toBeNull();
    expect(scanPartial({ tests_total: 200, tests_skipped: 0, tests_failed: null })).toBeNull();
    expect(scanPartial({ tests_total: 200, tests_skipped: null, tests_failed: 0 })).toBeNull();
  });

  it("a reported skip makes the run partial even with the total missing", () => {
    // Positive evidence stands on its own: knowing 91 cases were skipped settles the question,
    // whatever else the report failed to say.
    expect(scanPartial({ tests_total: null, tests_skipped: 91, tests_failed: null })).toBe(true);
    expect(scanPartial({ tests_total: null, tests_skipped: null, tests_failed: 27 })).toBe(true);
  });

  it("skipped OR failed cases mark the run partial", () => {
    // The aios-devtools case: one unset env var skipped 91 of 229 tests by design and moved
    // coverage 29 points with nothing going red.
    expect(scanPartial({ tests_total: 229, tests_skipped: 91, tests_failed: 0 })).toBe(true);
    expect(scanPartial({ tests_total: 451, tests_skipped: 0, tests_failed: 27 })).toBe(true);
    expect(scanPartial({ tests_total: 229, tests_skipped: 3, tests_failed: 0 })).toBe(true);
  });

  it("a run that executed ZERO tests is partial, not clean", () => {
    // The one degraded shape a skip/fail check cannot see: nothing was skipped because nothing
    // was collected. It arrives from a filter that matched no files, a runner that died before
    // collection, or a config pointed at the wrong directory — and it still ships a coverage
    // percentage. Previously this returned false and the UI then suppressed even the "clean"
    // text, because 0 is falsy: zero tests, no warning, coverage still on screen.
    expect(scanPartial({ tests_total: 0, tests_skipped: 0, tests_failed: 0 })).toBe(true);
    // Distinct from "no report at all", which stays unknown.
    expect(scanPartial({ tests_total: null, tests_skipped: null, tests_failed: null })).toBeNull();
  });

  it("a partial run does not change any score — it changes what the number means", () => {
    const clean = computeScores(FULLY_AGENTIC);
    const halfSkipped = computeScores({ ...FULLY_AGENTIC, tests_skipped: 91, tests_passed: 109 });
    expect(halfSkipped.agentic_score).toBe(clean.agentic_score);
    expect(halfSkipped.health_score).toBe(clean.health_score);
  });
});

describe("unscoped coverage — the headline requirement (AIO-995)", () => {
  // The change is named for one property: a coverage percentage must not be readable without
  // the scope it was measured over. The first cut satisfied that only when a denominator
  // existed — which is NO row until its next scan, so the common case was the unfixed one.
  it("a percentage with no denominator is UNSCOPED, and says so", () => {
    expect(isUnscopedCoverage(99, null, 3_140)).toBe(true);
    expect(isUnscopedCoverage(99, 436, 3_140)).toBe(false);
  });

  it("loc = 0 is unscoped — there is no denominator to divide by", () => {
    // A docs-only repo counts zero code lines. Breadth over that is not 100%, it is undefined.
    expect(isUnscopedCoverage(99, 436, 0)).toBe(true);
    expect(isUnscopedCoverage(99, 436, null)).toBe(true);
    expect(coverageBreadthPct({ ...FULLY_AGENTIC, test_coverage_lines_total: 436, loc: 0 })).toBeNull();
  });

  it("no coverage report at all is not 'unscoped' — there is no number to qualify", () => {
    expect(isUnscopedCoverage(null, null, 3_140)).toBe(false);
  });

  it("a measured zero-line denominator is still unscoped, not a scope of zero", () => {
    expect(isUnscopedCoverage(0, null, 3_140)).toBe(true);
  });
});
