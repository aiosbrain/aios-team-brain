// Shared builder for a FULL codebase-scan metrics block. The /api/v1/codebases schema
// requires the core raw-scan fields (so a sparse readiness-only push is rejected at the
// boundary — see lib/api/schemas.ts), so tests must send a complete block. Spread overrides
// for the fields a given test cares about.
export function fullMetrics(overrides: Record<string, unknown> = {}) {
  return {
    head_sha: "a".repeat(40),
    window_days: 90,
    loc: 1000,
    files: 50,
    commits_window: 4,
    ai_commits_window: 2,
    additions_window: 100,
    deletions_window: 20,
    test_coverage_pct: null,
    test_coverage_functions_pct: null,
    test_coverage_branches_pct: null,
    recent_commits: [],
    has_claude_md: false,
    has_agents_md: false,
    agents_md_count: 0,
    skills_count: 0,
    commands_count: 0,
    active_days: 2,
    days_since_last_commit: 1,
    ...overrides,
  };
}
