import { describe, expect, it } from "vitest";
import {
  computeScores,
  coverageScore,
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
  it("coverage: null report → 0; 80% → 100; 40% → 50", () => {
    expect(coverageScore({ ...FULLY_AGENTIC, test_coverage_pct: null })).toBe(0);
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

  it("dropping the coverage report lowers both scores (coverage carries weight)", () => {
    const withCov = computeScores(FULLY_AGENTIC);
    const noCov = computeScores({ ...FULLY_AGENTIC, test_coverage_pct: null });
    // agentic loses 0.25*100 = 25; health loses 0.4*100 = 40
    expect(noCov.agentic_score).toBe(withCov.agentic_score - 25);
    expect(noCov.health_score).toBe(withCov.health_score - 40);
    expect(noCov.test_coverage_score).toBe(0);
  });

  it("the AI-commit trailer is a low-weight signal, not the backbone", () => {
    // Halving AI commits (90→45) drops agentic by only 0.15*45 = 6.75.
    const base = computeScores(FULLY_AGENTIC);
    const halfAi = computeScores({ ...FULLY_AGENTIC, ai_commits_window: 45 });
    expect(base.agentic_score - halfAi.agentic_score).toBeCloseTo(6.75, 5);
  });
});
