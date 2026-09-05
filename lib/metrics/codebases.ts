import "server-only";
import type { CodebaseHealth } from "@/lib/api/schemas";
import type { DbClient } from "@/lib/db/types";
import type { Kpi } from "./pulse";
import { rangeDays, type Range } from "./range";
import { canSeeCodebases, type ViewerTier } from "@/lib/codebases/visibility";
import { isUnscopedCoverage, scanPartial } from "@/lib/codebases/score";
import {
  isScannerOutdated,
  scannerStaleness,
  type ScannerStaleness,
} from "@/lib/codebases/scanner-version";
import { num, numOrNull, round } from "@/lib/num";
import type { FindingStatus } from "@/lib/codebases/finding-ledger";
import { buildDebtPatrol, type DebtPatrol } from "@/lib/codebases/debt-ranking";
import {
  deriveCodebaseDebtKpis,
  type CodebaseDebtKpis,
} from "@/lib/codebases/debt-kpis";

/**
 * The ONLY read path for codebase analytics tables — pages must go through here,
 * never query the tables directly (codebases-tier-filter guard enforces both).
 * Every export takes the viewer `tier` and returns empty/null for `external`:
 * codebase intel is team-tier only and there is no RLS backstop in postgres mode.
 * Aggregation is done in JS over a fetched window (the pulse.ts pattern).
 */

export interface CodebaseSummary {
  id: string;
  slug: string;
  full_name: string;
  primary_language: string;
  stars: number;
  open_issues: number;
  last_scan_at: string | null;
  agentic_score: number;
  health_score: number;
  test_coverage_pct: number | null;
  /**
   * The scope `test_coverage_pct` was measured over (brain-api 1.22 / AIO-995). Rendering the
   * percentage without it lets a 436-line measurement and a 10,647-line one read as the same
   * claim. `coverage_breadth_pct` is null for every scan taken before 1.22 — unknown scope, not
   * full scope — so the card must be able to show a percentage with no scope attached.
   */
  test_coverage_lines_total: number | null;
  coverage_breadth_pct: number | null;
  /** Repository lines counted by the last scan — the denominator breadth is measured against. */
  loc: number | null;
  /** null = no test-result report (completeness unknown); true = the run skipped or failed cases. */
  scan_partial: boolean | null;
  /**
   * Which scanner build produced the last scan (brain-api 1.24 / AIO-1011), and how it compares
   * to what the current contract needs. `"unknown"` on every scan taken before 1.24 — and that is
   * a PERMANENT state, not a transient one, because the field cannot be backfilled.
   *
   * This is what turns an unexplained `(scope unknown)` into an attributable cause. 1.22's
   * denominator reached zero of seven repos because each was pinned to a scanner that could not
   * send it, and nothing anywhere said so.
   */
  scanner_version: string | null;
  scanner_staleness: ScannerStaleness;
  tests_skipped: number | null;
  tests_failed: number | null;
  tests_total: number | null;
  ai_commit_ratio: number;
  readiness_level: string | null; // AEM agent-readiness level (L0..L5), null = not scored
  readiness_pct: number | null;
  spark: number[]; // agentic_score trend (windowed; falls back to last points if the window is empty)
  stale: boolean; // last scan is older than STALE_DAYS — headline shows last-known values, flagged in the UI
  scanned: boolean; // has ≥1 code_metrics row — false = GitHub-API sync only (contributions, no readiness)
}

/**
 * A codebase's card headline (agentic/health/coverage/readiness) reflects its LAST scan
 * regardless of the selected range — a repo that hasn't been scanned recently keeps showing
 * its last-known numbers instead of blanking out. We only mark it `stale` (a UI badge) when
 * the newest scan is older than this. The sparkline stays range-windowed (with a fallback to
 * the most recent points so it never renders empty). There is no scanner backstop on the
 * postgres target — a stale card means "run a scan", not "no data".
 */
export const STALE_DAYS = 14;

/** True when the last scan is older than `staleDays` (or never scanned). Pure — unit-tested. */
export function isCodebaseStale(
  lastScanAt: string | null,
  nowMs: number,
  staleDays: number = STALE_DAYS,
): boolean {
  if (!lastScanAt) return true;
  const scannedMs = Date.parse(lastScanAt);
  if (Number.isNaN(scannedMs)) return true;
  return nowMs - scannedMs > staleDays * 86_400_000;
}

/**
 * Sparkline series from a newest-first metric series: the points inside the window, oldest→newest.
 * If the window holds fewer than two points (e.g. a repo not scanned recently), fall back to the
 * most recent `fallback` points overall so the card still shows its historical trend rather than a
 * flat/empty line. Pure — unit-tested.
 */
export function windowedSpark(
  seriesNewestFirst: {
    scanned_at: string | Date;
    agentic_score: number | string;
  }[],
  windowStartIso: string,
  fallback = 12,
): number[] {
  // Compare by epoch ms — the pg adapter returns `scanned_at` as a Date, not an ISO string,
  // so a lexicographic string compare would silently never match (the #134 gotcha).
  const windowStartMs = Date.parse(windowStartIso);
  const inWindow = seriesNewestFirst.filter(
    (s) => new Date(s.scanned_at).getTime() >= windowStartMs,
  );
  const source =
    inWindow.length >= 2 ? inWindow : seriesNewestFirst.slice(0, fallback);
  return source.map((s) => num(s.agentic_score)).reverse();
}

export interface CodebaseListResult {
  codebases: CodebaseSummary[];
  kpis: Kpi[];
}

type MetricRow = {
  codebase_id: string;
  scanned_at: string;
  agentic_score: number | string;
  health_score: number | string;
  test_coverage_pct: number | string | null;
  // brain-api 1.22 (AIO-995) — nullable on every row written before the columns existed.
  test_coverage_lines_total: number | string | null;
  coverage_breadth_pct: number | string | null;
  loc: number | string | null;
  tests_total: number | string | null;
  tests_skipped: number | string | null;
  tests_failed: number | string | null;
  // brain-api 1.24 (AIO-1011) — null on every row written before the column existed.
  scanner_version: string | null;
  ai_commit_ratio: number | string;
  readiness_level: string | null;
  readiness_pct: number | string | null;
};

export async function getCodebaseSummaries(
  db: DbClient,
  teamId: string,
  range: Range,
  tier: ViewerTier,
): Promise<CodebaseListResult> {
  if (!canSeeCodebases(tier)) return { codebases: [], kpis: [] };

  const now = Date.now();
  const windowStart = new Date(
    now - rangeDays(range) * 86_400_000,
  ).toISOString();

  const [cbRes, mRes] = await Promise.all([
    db
      .from("codebases")
      .select(
        "id, slug, full_name, primary_language, stars, open_issues, last_scan_at",
      )
      .eq("team_id", teamId)
      .order("last_scan_at", { ascending: false, nullsFirst: false }),
    // NOT windowed: we want each codebase's LAST scan for the headline even if it predates the
    // range, so a card never blanks out (it's flagged `stale` instead). The sparkline windows this
    // series in JS. DESC + limit keeps the NEWEST points (ascending+limit would drop them at scale).
    db
      .from("code_metrics")
      .select(
        "codebase_id, scanned_at, agentic_score, health_score, test_coverage_pct, " +
          "test_coverage_lines_total, coverage_breadth_pct, loc, tests_total, tests_skipped, tests_failed, " +
          "scanner_version, " +
          "ai_commit_ratio, readiness_level, readiness_pct",
      )
      .eq("team_id", teamId)
      .order("scanned_at", { ascending: false })
      .limit(10_000),
  ]);

  const codebases = (cbRes.data ?? []) as {
    id: string;
    slug: string;
    full_name: string;
    primary_language: string;
    stars: number;
    open_issues: number;
    last_scan_at: string | null;
  }[];
  const metrics = (mRes.data ?? []) as MetricRow[];

  // group metrics by codebase (rows arrive newest-first)
  const byCb = new Map<string, MetricRow[]>();
  for (const m of metrics) {
    const arr = byCb.get(m.codebase_id) ?? [];
    arr.push(m);
    byCb.set(m.codebase_id, arr);
  }

  const summaries: CodebaseSummary[] = codebases.map((cb) => {
    const series = byCb.get(cb.id) ?? []; // newest-first
    const latest = series[0];
    return {
      id: cb.id,
      slug: cb.slug,
      full_name: cb.full_name,
      primary_language: cb.primary_language,
      stars: cb.stars,
      open_issues: cb.open_issues,
      last_scan_at: cb.last_scan_at,
      agentic_score: num(latest?.agentic_score),
      health_score: num(latest?.health_score),
      test_coverage_pct:
        latest?.test_coverage_pct == null
          ? null
          : num(latest.test_coverage_pct),
      test_coverage_lines_total:
        latest?.test_coverage_lines_total == null
          ? null
          : num(latest.test_coverage_lines_total),
      coverage_breadth_pct:
        latest?.coverage_breadth_pct == null
          ? null
          : num(latest.coverage_breadth_pct),
      loc: latest?.loc == null ? null : num(latest.loc),
      tests_total: latest?.tests_total == null ? null : num(latest.tests_total),
      tests_skipped:
        latest?.tests_skipped == null ? null : num(latest.tests_skipped),
      tests_failed:
        latest?.tests_failed == null ? null : num(latest.tests_failed),
      // Derived here rather than stored: the raw counts are the durable fact, and one rule for
      // "partial" (lib/codebases/score.scanPartial) keeps the card and the detail page in step.
      scan_partial: latest
        ? scanPartial({
            tests_total:
              latest.tests_total == null ? null : num(latest.tests_total),
            tests_skipped:
              latest.tests_skipped == null ? null : num(latest.tests_skipped),
            tests_failed:
              latest.tests_failed == null ? null : num(latest.tests_failed),
          })
        : null,
      // Read from the LAST scan, like every other headline value. `scannerStaleness` maps an
      // absent or unparseable version to "unknown" — never to "current". A repo with no scan at
      // all also reads "unknown", which is the true statement: nothing has told us what would
      // scan it.
      scanner_version: latest?.scanner_version ?? null,
      scanner_staleness: scannerStaleness(latest?.scanner_version),
      ai_commit_ratio: num(latest?.ai_commit_ratio),
      readiness_level: latest?.readiness_level ?? null,
      readiness_pct:
        latest?.readiness_pct == null ? null : num(latest.readiness_pct),
      // windowed trend (falls back to the most recent points so a stale card still shows a line)
      spark: windowedSpark(series, windowStart),
      stale: isCodebaseStale(cb.last_scan_at, now),
      scanned: series.length > 0,
    };
  });

  return { codebases: summaries, kpis: teamKpis(summaries, range) };
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return round(nums.reduce((a, b) => a + b, 0) / nums.length, 1);
}

function teamKpis(s: CodebaseSummary[], range: Range): Kpi[] {
  const cov = s
    .map((c) => c.test_coverage_pct)
    .filter((v): v is number => v != null);
  // How many of the averaged percentages arrived without a denominator (AIO-995). The mean of a
  // set of percentages measured over wildly different fractions of their repos is not a team
  // coverage figure — a repo measuring 436 lines contributes exactly as much as one measuring
  // 10,647. We keep the average (it is the number people have been reading, and dropping it
  // would be its own distortion) but the hint now says how much of it is unscoped, so nobody
  // reads it as a claim about the team's code rather than about a bag of unlike numbers.
  const unscoped = s.filter((c) =>
    isUnscopedCoverage(c.test_coverage_pct, c.test_coverage_lines_total, c.loc),
  ).length;
  // How many of the unscoped ones are unscoped BECAUSE their scanner cannot report scope
  // (brain-api 1.24 / AIO-1011). "7 without scope" was true and unactionable — it read as a
  // property of the repos when it was a property of their pins. Naming the cause makes it a
  // thing someone can fix. Counted only among the repos already contributing to the average, so
  // the hint stays a description of THIS number rather than of the whole fleet.
  //
  // The wording is "not current", NOT "stale", and that is deliberate. This count is the UNION of
  // the stale and unknown states, and calling the union "stale" would assert something false
  // about the unknown ones: they did not declare an old build, they declared nothing. That is
  // the common case — every scan taken before 1.24 — so the wrong word here would be the word
  // shown for the whole fleet on day one. The card badge still distinguishes the two states
  // ("scanner outdated" vs "scanner unknown"); this aggregate only claims what it can support.
  const notCurrentScanner = s.filter(
    (c) =>
      isUnscopedCoverage(c.test_coverage_pct, c.test_coverage_lines_total, c.loc) &&
      isScannerOutdated(c.scanner_staleness),
  ).length;
  return [
    {
      key: "agentic",
      label: "Avg agentic score",
      value: String(avg(s.map((c) => c.agentic_score))),
      delta: null,
      spark: [],
      hint: `${s.length} ${s.length === 1 ? "repo" : "repos"}`,
      accent: "violet",
    },
    {
      key: "health",
      label: "Avg health",
      value: String(avg(s.map((c) => c.health_score))),
      delta: null,
      spark: [],
      hint: `last ${rangeDays(range)}d`,
      accent: "emerald",
    },
    {
      key: "coverage",
      label: "Avg coverage",
      value: cov.length ? `${avg(cov)}%` : "—",
      delta: null,
      spark: [],
      hint: cov.length
        ? unscoped > 0
          ? notCurrentScanner > 0
            ? `${cov.length} reporting · ${unscoped} without scope (${notCurrentScanner} scanner not current)`
            : `${cov.length} reporting · ${unscoped} without scope`
          : `${cov.length} reporting`
        : "no reports",
      accent: "cyan",
    },
    {
      key: "ai",
      label: "AI-assisted commits",
      value: `${avg(s.map((c) => c.ai_commit_ratio))}%`,
      delta: null,
      spark: [],
      hint: "heuristic",
      accent: "blue",
    },
    {
      key: "issues",
      label: "Open issues",
      value: String(s.reduce((a, c) => a + c.open_issues, 0)),
      delta: null,
      spark: [],
      hint: "across repos",
      accent: "amber",
    },
  ];
}

// ── scan freshness (W1.3) ───────────────────────────────────────────────────────

export interface CodebaseFreshness {
  id: string;
  slug: string;
  full_name: string;
  default_branch: string;
  last_scan_at: string | null;
  last_scanned_sha: string | null; // newest code_metrics.head_sha, null if never scanned
}

/**
 * Per-codebase scan freshness for the Codebases → GitHub surface: the repo's full_name +
 * default_branch, when it was last scanned, and the SHA that scan was taken at (the newest
 * `code_metrics.head_sha`). The page compares `last_scanned_sha` to the live branch HEAD
 * (`lib/codebases/github.fetchRepoHeadSha`) to show fresh/stale — there is NO server-triggered
 * scan in Wave 1; the page documents the manual `aios-ingest scan` command. Tier-gated team-only
 * like the rest of codebase analytics (sole enforcement on postgres, no RLS).
 */
export async function getCodebaseFreshness(
  db: DbClient,
  teamId: string,
  tier: ViewerTier,
): Promise<CodebaseFreshness[]> {
  if (!canSeeCodebases(tier)) return [];

  const { data: cbData } = await db
    .from("codebases")
    .select("id, slug, full_name, default_branch, last_scan_at")
    .eq("team_id", teamId)
    .order("full_name", { ascending: true });
  const codebases = (cbData ?? []) as {
    id: string;
    slug: string;
    full_name: string;
    default_branch: string;
    last_scan_at: string | null;
  }[];
  if (codebases.length === 0) return [];

  // Newest head_sha per codebase (rows arrive newest-first; first seen wins).
  const { data: mData } = await db
    .from("code_metrics")
    .select("codebase_id, head_sha, scanned_at")
    .eq("team_id", teamId)
    .order("scanned_at", { ascending: false })
    .limit(10_000);
  const latestSha = new Map<string, string>();
  for (const m of (mData ?? []) as {
    codebase_id: string;
    head_sha: string;
  }[]) {
    if (!latestSha.has(m.codebase_id)) latestSha.set(m.codebase_id, m.head_sha);
  }

  return codebases.map((cb) => ({
    id: cb.id,
    slug: cb.slug,
    full_name: cb.full_name,
    default_branch: cb.default_branch,
    last_scan_at: cb.last_scan_at,
    last_scanned_sha: latestSha.get(cb.id) ?? null,
  }));
}

// ── detail ────────────────────────────────────────────────────────────────────

export interface AgenticBreakdown {
  agentic_score: number;
  health_score: number;
  ai_commit_ratio: number;
  /** null = no coverage report; NOT a measured 0%. */
  test_coverage_score: number | null;
  scaffolding_score: number;
  skill_breadth_score: number;
  cadence_score: number;
  issue_health: number;
  has_claude_md: boolean;
  has_agents_md: boolean;
  agents_md_count: number;
  skills_count: number;
  commands_count: number;
  test_coverage_pct: number | null;
  test_coverage_functions_pct: number | null;
  test_coverage_branches_pct: number | null;
  // brain-api 1.22 (AIO-995) — the coverage denominator + the integrity of the run behind it.
  // All null on a pre-1.22 scan: unknown scope and unknown completeness, never zero.
  test_coverage_lines_total: number | null;
  test_coverage_lines_covered: number | null;
  coverage_breadth_pct: number | null;
  /** Repository lines counted by the scanner — the denominator `coverage_breadth_pct` is over. */
  loc: number;
  tests_total: number | null;
  tests_passed: number | null;
  tests_skipped: number | null;
  tests_failed: number | null;
  /** null = completeness unknown (no test-result report); true = cases skipped or failed. */
  scan_partial: boolean | null;
  /** Which scanner build produced this scan (brain-api 1.24 / AIO-1011). null = unknown build. */
  scanner_version: string | null;
  /** Provenance only — the brain commit the scanner ran from, for locating a stale pin. */
  scanner_sha: string | null;
  scanner_staleness: ScannerStaleness;
  readiness_level: string | null;
  readiness_pct: number | null;
  readiness_pillars: Record<string, { passed: number; total: number }>;
  // Workspace-governance health (brain-api 1.15) — the LAST scan's snapshot, verbatim as
  // pushed (incl. measured_at); null = that scan carried no health object. Provenance-only.
  codebase_health: CodebaseHealth | null;
}

export interface TrendPoint {
  date: string;
  agentic: number;
  coverage: number | null;
  ai: number;
}

export interface ContributorRow {
  author_key: string;
  author_name: string;
  member_id: string | null;
  member_name: string | null;
  avatar_url: string | null;
  avatar_data_url: string | null;
  github_login: string | null;
  commits: number;
  ai_commits: number;
  additions: number;
  deletions: number;
}

export interface IssueRow {
  number: number;
  title: string;
  state: string;
  is_pull_request: boolean;
  author_login: string;
  labels: string[];
  url: string;
  opened_at: string | null;
}

export interface CommitVolumePoint {
  date: string; // YYYY-MM-DD
  ai: number;
  human: number;
}

export interface CodebaseFindingEvent {
  id: string;
  event_type: string;
  from_status: FindingStatus | null;
  to_status: FindingStatus;
  head_sha: string;
  observed_at: string;
  details: Record<string, unknown>;
}

export interface CodebaseFinding {
  id: string;
  fingerprint: string;
  status: FindingStatus;
  check_id: string;
  axis: string;
  kind: "quality_issue" | "evidence_gap";
  severity: "low" | "medium" | "high" | "critical";
  evidence_status: "complete" | "partial" | "missing" | "stale" | "error";
  remediation_tier: number;
  first_seen_sha: string;
  last_seen_sha: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  occurrence_count: number;
  decision_reason: string | null;
  decision_owner_member_id: string | null;
  decision_owner_name: string | null;
  decision_by_member_id: string | null;
  decision_by_member_name: string | null;
  decision_at: string | null;
  decision_expires_at: string | null;
  events: CodebaseFindingEvent[];
}

export interface FindingDecisionOwner {
  id: string;
  display_name: string;
}

export interface CodebaseDetail {
  id: string;
  slug: string;
  full_name: string;
  default_branch: string;
  description: string;
  homepage: string;
  primary_language: string;
  languages: Record<string, number>;
  stars: number;
  forks: number;
  open_issues: number;
  last_scan_at: string | null;
  stale: boolean; // last scan older than STALE_DAYS — headline is last-known; windowed charts may be empty
  breakdown: AgenticBreakdown | null;
  recent_commits: Record<string, unknown>[];
  trend: TrendPoint[];
  commitVolume: CommitVolumePoint[];
  contributors: ContributorRow[];
  issues: IssueRow[];
  findings: CodebaseFinding[];
  decisionOwners: FindingDecisionOwner[];
  debtPatrol: DebtPatrol;
  debtKpis: CodebaseDebtKpis;
}

export async function getCodebaseIdentity(
  db: DbClient,
  teamId: string,
  slug: string,
  tier: ViewerTier,
): Promise<{ id: string } | null> {
  if (!canSeeCodebases(tier)) return null;
  const { data } = await db
    .from("codebases")
    .select("id")
    .eq("team_id", teamId)
    .eq("slug", slug)
    .maybeSingle();
  return data ? { id: (data as { id: string }).id } : null;
}

export async function getCodebaseDetail(
  db: DbClient,
  teamId: string,
  slug: string,
  range: Range,
  tier: ViewerTier,
): Promise<CodebaseDetail | null> {
  if (!canSeeCodebases(tier)) return null;

  const { data: cb } = await db
    .from("codebases")
    .select(
      "id, slug, full_name, default_branch, description, homepage, primary_language, languages, stars, forks, open_issues, last_scan_at",
    )
    .eq("team_id", teamId)
    .eq("slug", slug)
    .maybeSingle();
  if (!cb) return null;

  const codebaseId = (cb as { id: string }).id;
  const rangeEnd = new Date().toISOString();
  const windowStart = new Date(
    Date.parse(rangeEnd) - rangeDays(range) * 86_400_000,
  ).toISOString();

  const METRIC_COLS =
    "scanned_at, window_days, commits_window, agentic_score, health_score, ai_commit_ratio, test_coverage_score, " +
    "scaffolding_score, skill_breadth_score, cadence_score, issue_health, has_claude_md, " +
    "has_agents_md, agents_md_count, skills_count, commands_count, test_coverage_pct, " +
    "test_coverage_functions_pct, test_coverage_branches_pct, recent_commits, " +
    "test_coverage_lines_total, test_coverage_lines_covered, coverage_breadth_pct, loc, " +
    "tests_total, tests_passed, tests_skipped, tests_failed, " +
    "readiness_level, readiness_pct, readiness_pillars, codebase_health, " +
    "scanner_version, scanner_sha";

  const [
    metricsRes,
    contribRes,
    issuesRes,
    membersRes,
    profilesRes,
    findingsRes,
    findingEventsRes,
  ] = await Promise.all([
    // NOT windowed: the breakdown/headline reflect the LAST scan even if it predates the range
    // (a stale detail page keeps its last-known values). The trend windows this series in JS below.
    db
      .from("code_metrics")
      .select(METRIC_COLS)
      .eq("codebase_id", codebaseId)
      // DESC + limit keeps the newest points; reversed below for chronological trend.
      .order("scanned_at", { ascending: false })
      .limit(2000),
    db
      .from("code_contributions")
      .select(
        "author_key, author_name, member_id, day, commits, ai_commits, additions, deletions",
      )
      .eq("codebase_id", codebaseId)
      .gte("day", windowStart.slice(0, 10))
      .limit(10_000),
    db
      .from("github_issues")
      .select(
        "number, title, state, is_pull_request, author_login, labels, url, opened_at",
      )
      .eq("codebase_id", codebaseId)
      .order("updated_at", { ascending: false })
      .limit(200),
    db
      .from("members")
      .select("id, display_name, github_login, avatar_url, tier, status")
      .eq("team_id", teamId),
    // Uploaded avatars live on member_profiles (1:1, separate table) — sibling query, merged in JS.
    db
      .from("member_profiles")
      .select("member_id, avatar_data_url")
      .eq("team_id", teamId),
    db
      .from("codebase_findings")
      .select(
        "id, fingerprint, status, check_id, axis, kind, severity, evidence_status, remediation_tier, occurrence_count, first_seen_sha, last_seen_sha, first_seen_at, last_seen_at, resolved_at, decision_reason, decision_owner_member_id, decision_by_member_id, decision_at, decision_expires_at",
      )
      .eq("team_id", teamId)
      .eq("codebase_id", codebaseId)
      .order("last_seen_at", { ascending: false }),
    db
      .from("codebase_finding_events")
      .select(
        "id, finding_id, event_type, from_status, to_status, head_sha, observed_at, details",
      )
      .eq("team_id", teamId)
      .eq("codebase_id", codebaseId)
      .order("observed_at", { ascending: false }),
  ]);

  type MemberMeta = {
    display_name: string | null;
    github_login: string | null;
    avatar_url: string | null;
  };
  const avatarDataByMember = new Map(
    (
      (profilesRes.data ?? []) as {
        member_id: string;
        avatar_data_url: string | null;
      }[]
    ).map((p) => [p.member_id, p.avatar_data_url]),
  );
  const members = new Map<string, MemberMeta>();
  for (const m of (membersRes.data ?? []) as ({ id: string } & MemberMeta)[]) {
    members.set(m.id, {
      display_name: m.display_name,
      github_login: m.github_login,
      avatar_url: m.avatar_url,
    });
  }
  const decisionOwners = (
    (membersRes.data ?? []) as Array<
      { id: string; tier: string; status: string } & MemberMeta
    >
  )
    .filter((member) => member.tier === "team" && member.status === "active")
    .map((member) => ({
      id: member.id,
      display_name:
        member.display_name ?? member.github_login ?? "Unnamed member",
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  // newest-first from the query. `latest` is the true last scan (unwindowed) so the breakdown
  // never blanks; the trend is windowed with a fallback to the most recent points.
  const metrics = (metricsRes.data ?? []) as unknown as Record<
    string,
    unknown
  >[];
  // Compare by epoch ms — scanned_at comes back as a Date via the pg adapter (#134 gotcha).
  const windowStartMs = Date.parse(windowStart);
  const inWindow = metrics.filter(
    (m) => new Date(m.scanned_at as string | Date).getTime() >= windowStartMs,
  );
  const chronological = [
    ...(inWindow.length >= 2 ? inWindow : metrics.slice(0, 12)),
  ].reverse();
  const latest = metrics[0];

  const breakdown: AgenticBreakdown | null = latest
    ? {
        agentic_score: num(latest.agentic_score as number),
        health_score: num(latest.health_score as number),
        ai_commit_ratio: num(latest.ai_commit_ratio as number),
        test_coverage_score: numOrNull(
          latest.test_coverage_score as number | null,
        ),
        scaffolding_score: num(latest.scaffolding_score as number),
        skill_breadth_score: num(latest.skill_breadth_score as number),
        cadence_score: num(latest.cadence_score as number),
        issue_health: num(latest.issue_health as number),
        has_claude_md: Boolean(latest.has_claude_md),
        has_agents_md: Boolean(latest.has_agents_md),
        agents_md_count: num(latest.agents_md_count as number),
        skills_count: num(latest.skills_count as number),
        commands_count: num(latest.commands_count as number),
        test_coverage_pct:
          latest.test_coverage_pct == null
            ? null
            : num(latest.test_coverage_pct as number),
        test_coverage_functions_pct:
          latest.test_coverage_functions_pct == null
            ? null
            : num(latest.test_coverage_functions_pct as number),
        test_coverage_branches_pct:
          latest.test_coverage_branches_pct == null
            ? null
            : num(latest.test_coverage_branches_pct as number),
        test_coverage_lines_total: numOrNull(
          latest.test_coverage_lines_total as number | null,
        ),
        test_coverage_lines_covered: numOrNull(
          latest.test_coverage_lines_covered as number | null,
        ),
        coverage_breadth_pct: numOrNull(
          latest.coverage_breadth_pct as number | null,
        ),
        loc: num(latest.loc as number),
        tests_total: numOrNull(latest.tests_total as number | null),
        tests_passed: numOrNull(latest.tests_passed as number | null),
        tests_skipped: numOrNull(latest.tests_skipped as number | null),
        tests_failed: numOrNull(latest.tests_failed as number | null),
        scan_partial: scanPartial({
          tests_total: numOrNull(latest.tests_total as number | null),
          tests_skipped: numOrNull(latest.tests_skipped as number | null),
          tests_failed: numOrNull(latest.tests_failed as number | null),
        }),
        // Stored verbatim, read as a verdict here — including a version string this server
        // cannot parse, which reads "unknown" rather than being rejected or silently passed.
        scanner_version: (latest.scanner_version as string | null) ?? null,
        scanner_sha: (latest.scanner_sha as string | null) ?? null,
        scanner_staleness: scannerStaleness(
          latest.scanner_version as string | null,
        ),
        readiness_level: (latest.readiness_level as string | null) ?? null,
        readiness_pct:
          latest.readiness_pct == null
            ? null
            : num(latest.readiness_pct as number),
        readiness_pillars:
          (latest.readiness_pillars as Record<
            string,
            { passed: number; total: number }
          >) ?? {},
        codebase_health:
          (latest.codebase_health as CodebaseHealth | null) ?? null,
      }
    : null;

  const trend: TrendPoint[] = chronological.map((m) => ({
    date: new Date(m.scanned_at as string).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    agentic: num(m.agentic_score as number),
    coverage:
      m.test_coverage_pct == null ? null : num(m.test_coverage_pct as number),
    ai: num(m.ai_commit_ratio as number),
  }));

  // aggregate contributions per author across the window
  const contribRows = (contribRes.data ?? []) as {
    author_key: string;
    author_name: string;
    member_id: string | null;
    day: string | Date;
    commits: number;
    ai_commits: number;
    additions: number;
    deletions: number;
  }[];

  // commit volume per day (AI vs human) for the commit-volume chart. Normalize the pg
  // `date` column (Date or string) via dayStr — local components, no UTC midnight shift.
  const volByDay = new Map<string, { ai: number; human: number }>();
  for (const r of contribRows) {
    const k = dayStr(r.day);
    const v = volByDay.get(k) ?? { ai: 0, human: 0 };
    v.ai += r.ai_commits;
    v.human += Math.max(0, r.commits - r.ai_commits);
    volByDay.set(k, v);
  }
  const commitVolume: CommitVolumePoint[] = [...volByDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({
      date: new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      ai: v.ai,
      human: v.human,
    }));
  // Group by member when mapped (collapses one person's multiple git identities into
  // one row); fall back to per-author_key for genuinely unmapped contributors.
  const byContributor = new Map<string, ContributorRow>();
  for (const r of contribRows) {
    const groupKey = r.member_id ?? `unmapped:${r.author_key}`;
    const meta = r.member_id ? members.get(r.member_id) : undefined;
    const cur =
      byContributor.get(groupKey) ??
      ({
        author_key: r.author_key,
        author_name: r.author_name,
        member_id: r.member_id,
        member_name: meta?.display_name ?? null,
        avatar_url: meta?.avatar_url ?? null,
        avatar_data_url: r.member_id
          ? (avatarDataByMember.get(r.member_id) ?? null)
          : null,
        github_login: meta?.github_login ?? null,
        commits: 0,
        ai_commits: 0,
        additions: 0,
        deletions: 0,
      } as ContributorRow);
    cur.commits += r.commits;
    cur.ai_commits += r.ai_commits;
    cur.additions += r.additions;
    cur.deletions += r.deletions;
    byContributor.set(groupKey, cur);
  }
  const contributors = [...byContributor.values()].sort(
    (a, b) => b.commits - a.commits,
  );

  const issues = ((issuesRes.data ?? []) as IssueRow[]).map((i) => ({
    ...i,
    labels: Array.isArray(i.labels) ? i.labels : [],
  }));

  type FindingEventRow = Omit<CodebaseFindingEvent, "observed_at"> & {
    finding_id: string;
    observed_at: string | Date;
  };
  const findingEventsById = new Map<string, CodebaseFindingEvent[]>();
  for (const row of (findingEventsRes.data ?? []) as FindingEventRow[]) {
    const events = findingEventsById.get(row.finding_id) ?? [];
    events.push({
      id: row.id,
      event_type: row.event_type,
      from_status: row.from_status,
      to_status: row.to_status,
      head_sha: row.head_sha,
      observed_at: new Date(row.observed_at).toISOString(),
      details: row.details ?? {},
    });
    findingEventsById.set(row.finding_id, events);
  }

  type FindingRow = Omit<
    CodebaseFinding,
    | "first_seen_at"
    | "last_seen_at"
    | "resolved_at"
    | "decision_at"
    | "decision_expires_at"
    | "decision_owner_name"
    | "decision_by_member_name"
    | "events"
  > & {
    first_seen_at: string | Date;
    last_seen_at: string | Date;
    resolved_at: string | Date | null;
    decision_at: string | Date | null;
    decision_expires_at: string | Date | null;
  };
  const findings: CodebaseFinding[] = (
    (findingsRes.data ?? []) as FindingRow[]
  ).map((row) => {
    const events = findingEventsById.get(row.id) ?? [];
    return {
      ...row,
      remediation_tier: num(row.remediation_tier),
      occurrence_count: num(row.occurrence_count),
      first_seen_at: new Date(row.first_seen_at).toISOString(),
      last_seen_at: new Date(row.last_seen_at).toISOString(),
      resolved_at:
        row.resolved_at == null
          ? null
          : new Date(row.resolved_at).toISOString(),
      decision_owner_name:
        row.decision_owner_member_id == null
          ? null
          : (members.get(row.decision_owner_member_id)?.display_name ??
            "Former member"),
      decision_by_member_name:
        row.decision_by_member_id == null
          ? null
          : (members.get(row.decision_by_member_id)?.display_name ??
            "Former member"),
      decision_at:
        row.decision_at == null
          ? null
          : new Date(row.decision_at).toISOString(),
      decision_expires_at:
        row.decision_expires_at == null
          ? null
          : new Date(row.decision_expires_at).toISOString(),
      events,
    };
  });

  const patrolGeneratedAt = rangeEnd;
  const debtPatrol = buildDebtPatrol(findings, {
    commitsWindow:
      latest?.commits_window == null
        ? null
        : num(latest.commits_window as number),
    windowDays:
      latest?.window_days == null ? null : num(latest.window_days as number),
    now: patrolGeneratedAt,
  });
  const recentCommits = Array.isArray(latest?.recent_commits)
    ? (latest.recent_commits as Record<string, unknown>[])
    : [];
  const debtKpis = deriveCodebaseDebtKpis({
    findings,
    commits: recentCommits,
    rangeStart: windowStart,
    rangeEnd,
    asOf: rangeEnd,
    commitsWindow:
      latest?.commits_window == null
        ? null
        : num(latest.commits_window as number),
    scannerWindowDays:
      latest?.window_days == null ? null : num(latest.window_days as number),
  });

  const c = cb as Record<string, unknown>;
  return {
    id: codebaseId,
    slug: c.slug as string,
    full_name: c.full_name as string,
    default_branch: c.default_branch as string,
    description: c.description as string,
    homepage: c.homepage as string,
    primary_language: c.primary_language as string,
    languages: (c.languages as Record<string, number>) ?? {},
    stars: num(c.stars as number),
    forks: num(c.forks as number),
    open_issues: num(c.open_issues as number),
    last_scan_at: (c.last_scan_at as string) ?? null,
    stale: isCodebaseStale(
      (c.last_scan_at as string) ?? null,
      Date.parse(rangeEnd),
    ),
    breakdown,
    recent_commits: recentCommits,
    trend,
    commitVolume,
    contributors,
    issues,
    findings,
    decisionOwners,
    debtPatrol,
    debtKpis,
  };
}

// ── Contributor drill-down + member profile (tier-gated, team-only) ───────────

export interface ContributorDay {
  day: string; // YYYY-MM-DD
  commits: number;
  ai_commits: number;
  additions: number;
  deletions: number;
}

export interface ContributorDetail {
  codebase_slug: string;
  author_key: string;
  member_id: string | null;
  name: string;
  avatar_url: string | null;
  github_login: string | null;
  totals: {
    commits: number;
    ai_commits: number;
    additions: number;
    deletions: number;
    active_days: number;
  };
  days: ContributorDay[];
}

/** Identify a contributor either by mapped member (aggregates all their aliases) or by
 *  a raw author_key (unmapped). */
export type ContributorRef = { memberId: string } | { authorKey: string };

function emptyDay(day: string): ContributorDay {
  return { day, commits: 0, ai_commits: 0, additions: 0, deletions: 0 };
}

/** Normalize a `date` column (pg adapter returns it as a Date, sometimes a string) to YYYY-MM-DD. */
function dayStr(v: string | Date): string {
  if (typeof v === "string") return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
}

/**
 * Per-day contributions for one contributor within a codebase — powers the drill-down
 * (commit heatmap + trend). Tier-gated: team-only, like the rest of codebase analytics
 * (the `lib/metrics/codebases` choke-point is the sole enforcement on postgres).
 */
export async function getContributorDetail(
  db: DbClient,
  teamId: string,
  slug: string,
  ref: ContributorRef,
  range: Range,
  tier: ViewerTier,
): Promise<ContributorDetail | null> {
  if (!canSeeCodebases(tier)) return null;

  const { data: cb } = await db
    .from("codebases")
    .select("id, slug")
    .eq("team_id", teamId)
    .eq("slug", slug)
    .maybeSingle();
  if (!cb) return null;

  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let q = db
    .from("code_contributions")
    .select(
      "author_key, author_name, member_id, day, commits, ai_commits, additions, deletions",
    )
    .eq("codebase_id", (cb as { id: string }).id)
    .gte("day", windowStart)
    .order("day", { ascending: true })
    .limit(10_000);
  q =
    "memberId" in ref
      ? q.eq("member_id", ref.memberId)
      : q.eq("author_key", ref.authorKey);

  const { data } = await q;
  const rows = (data ?? []) as {
    author_key: string;
    author_name: string;
    member_id: string | null;
    day: string | Date;
    commits: number;
    ai_commits: number;
    additions: number;
    deletions: number;
  }[];
  if (rows.length === 0) return null;

  const byDay = new Map<string, ContributorDay>();
  const totals = {
    commits: 0,
    ai_commits: 0,
    additions: 0,
    deletions: 0,
    active_days: 0,
  };
  for (const r of rows) {
    const day = dayStr(r.day);
    const d = byDay.get(day) ?? emptyDay(day);
    d.commits += r.commits;
    d.ai_commits += r.ai_commits;
    d.additions += r.additions;
    d.deletions += r.deletions;
    byDay.set(day, d);
    totals.commits += r.commits;
    totals.ai_commits += r.ai_commits;
    totals.additions += r.additions;
    totals.deletions += r.deletions;
  }
  totals.active_days = byDay.size;

  let name = rows[0].author_name || rows[0].author_key;
  let avatar_url: string | null = null;
  let github_login: string | null = null;
  const member_id =
    "memberId" in ref
      ? ref.memberId
      : (rows.find((r) => r.member_id)?.member_id ?? null);
  if (member_id) {
    const { data: m } = await db
      .from("members")
      .select("display_name, avatar_url, github_login")
      .eq("id", member_id)
      .eq("team_id", teamId)
      .maybeSingle();
    if (m) {
      const mm = m as {
        display_name: string | null;
        avatar_url: string | null;
        github_login: string | null;
      };
      name = mm.display_name ?? name;
      avatar_url = mm.avatar_url;
      github_login = mm.github_login;
    }
  }

  return {
    codebase_slug: (cb as { slug: string }).slug,
    author_key: rows[0].author_key,
    member_id,
    name,
    avatar_url,
    github_login,
    totals,
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export interface MemberProfileRepo {
  slug: string;
  commits: number;
  ai_commits: number;
}

export interface MemberProfile {
  member_id: string;
  handle: string;
  name: string;
  avatar_url: string | null;
  github_login: string | null;
  role: string;
  totals: {
    commits: number;
    ai_commits: number;
    additions: number;
    deletions: number;
    active_days: number;
  };
  repos: MemberProfileRepo[];
  days: ContributorDay[]; // across all codebases — for a cross-repo heatmap
}

/**
 * A member profile: identity (GitHub avatar) + their contributions aggregated across all
 * the team's codebases. Looked up by `actor_handle` or `github_login`. Tier-gated team-only.
 */
export async function getMemberProfile(
  db: DbClient,
  teamId: string,
  handle: string,
  range: Range,
  tier: ViewerTier,
): Promise<MemberProfile | null> {
  if (!canSeeCodebases(tier)) return null;

  const { data: members } = await db
    .from("members")
    .select(
      "id, display_name, actor_handle, github_login, avatar_url, role, status",
    )
    .eq("team_id", teamId);
  const lc = handle.toLowerCase();
  const member = (
    (members ?? []) as {
      id: string;
      display_name: string | null;
      actor_handle: string | null;
      github_login: string | null;
      avatar_url: string | null;
      role: string;
      status: string;
    }[]
  ).find(
    (m) =>
      m.status === "active" &&
      (m.actor_handle?.toLowerCase() === lc ||
        m.github_login?.toLowerCase() === lc ||
        m.id === handle),
  );
  if (!member) return null;

  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: contribs } = await db
    .from("code_contributions")
    .select("day, commits, ai_commits, additions, deletions, codebases(slug)")
    .eq("team_id", teamId)
    .eq("member_id", member.id)
    .gte("day", windowStart)
    .order("day", { ascending: true })
    .limit(20_000);

  const rows = (contribs ?? []) as unknown as {
    day: string | Date;
    commits: number;
    ai_commits: number;
    additions: number;
    deletions: number;
    codebases: { slug: string } | null;
  }[];

  const byDay = new Map<string, ContributorDay>();
  const byRepo = new Map<string, MemberProfileRepo>();
  const totals = {
    commits: 0,
    ai_commits: 0,
    additions: 0,
    deletions: 0,
    active_days: 0,
  };
  for (const r of rows) {
    const day = dayStr(r.day);
    const d = byDay.get(day) ?? emptyDay(day);
    d.commits += r.commits;
    d.ai_commits += r.ai_commits;
    d.additions += r.additions;
    d.deletions += r.deletions;
    byDay.set(day, d);
    const slug = r.codebases?.slug ?? "unknown";
    const repo = byRepo.get(slug) ?? { slug, commits: 0, ai_commits: 0 };
    repo.commits += r.commits;
    repo.ai_commits += r.ai_commits;
    byRepo.set(slug, repo);
    totals.commits += r.commits;
    totals.ai_commits += r.ai_commits;
    totals.additions += r.additions;
    totals.deletions += r.deletions;
  }
  totals.active_days = byDay.size;

  return {
    member_id: member.id,
    handle: member.actor_handle ?? member.github_login ?? member.id,
    name: member.display_name ?? member.actor_handle ?? "Member",
    avatar_url: member.avatar_url,
    github_login: member.github_login,
    role: member.role,
    totals,
    repos: [...byRepo.values()].sort((a, b) => b.commits - a.commits),
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
