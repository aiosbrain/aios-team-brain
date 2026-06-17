import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Kpi } from "./pulse";
import { rangeDays, type Range } from "./range";
import { canSeeCodebases, type ViewerTier } from "@/lib/codebases/visibility";
import { num, round } from "@/lib/num";

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
  ai_commit_ratio: number;
  spark: number[]; // agentic_score over the window
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
  ai_commit_ratio: number | string;
};

export async function getCodebaseSummaries(
  supabase: SupabaseClient,
  teamId: string,
  range: Range,
  tier: ViewerTier
): Promise<CodebaseListResult> {
  if (!canSeeCodebases(tier)) return { codebases: [], kpis: [] };

  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString();

  const [cbRes, mRes] = await Promise.all([
    supabase
      .from("codebases")
      .select("id, slug, full_name, primary_language, stars, open_issues, last_scan_at")
      .eq("team_id", teamId)
      .order("last_scan_at", { ascending: false, nullsFirst: false }),
    supabase
      .from("code_metrics")
      .select("codebase_id, scanned_at, agentic_score, health_score, test_coverage_pct, ai_commit_ratio")
      .eq("team_id", teamId)
      .gte("scanned_at", windowStart)
      // DESC + limit keeps the NEWEST points (ascending+limit would drop them at scale).
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
      test_coverage_pct: latest?.test_coverage_pct == null ? null : num(latest.test_coverage_pct),
      ai_commit_ratio: num(latest?.ai_commit_ratio),
      // chronological for the sparkline (series is newest-first)
      spark: series.map((s) => num(s.agentic_score)).reverse(),
    };
  });

  return { codebases: summaries, kpis: teamKpis(summaries, range) };
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return round(nums.reduce((a, b) => a + b, 0) / nums.length, 1);
}

function teamKpis(s: CodebaseSummary[], range: Range): Kpi[] {
  const cov = s.map((c) => c.test_coverage_pct).filter((v): v is number => v != null);
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
      hint: cov.length ? `${cov.length} reporting` : "no reports",
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

// ── detail ────────────────────────────────────────────────────────────────────

export interface AgenticBreakdown {
  agentic_score: number;
  health_score: number;
  ai_commit_ratio: number;
  test_coverage_score: number;
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
  breakdown: AgenticBreakdown | null;
  recent_commits: Record<string, unknown>[];
  trend: TrendPoint[];
  contributors: ContributorRow[];
  issues: IssueRow[];
}

export async function getCodebaseDetail(
  supabase: SupabaseClient,
  teamId: string,
  slug: string,
  range: Range,
  tier: ViewerTier
): Promise<CodebaseDetail | null> {
  if (!canSeeCodebases(tier)) return null;

  const { data: cb } = await supabase
    .from("codebases")
    .select(
      "id, slug, full_name, default_branch, description, homepage, primary_language, languages, stars, forks, open_issues, last_scan_at"
    )
    .eq("team_id", teamId)
    .eq("slug", slug)
    .maybeSingle();
  if (!cb) return null;

  const codebaseId = (cb as { id: string }).id;
  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString();

  const METRIC_COLS =
    "scanned_at, agentic_score, health_score, ai_commit_ratio, test_coverage_score, " +
    "scaffolding_score, skill_breadth_score, cadence_score, issue_health, has_claude_md, " +
    "has_agents_md, agents_md_count, skills_count, commands_count, test_coverage_pct, recent_commits";

  const [metricsRes, contribRes, issuesRes, membersRes] = await Promise.all([
    supabase
      .from("code_metrics")
      .select(METRIC_COLS)
      .eq("codebase_id", codebaseId)
      .gte("scanned_at", windowStart)
      // DESC + limit keeps the newest points; reversed below for chronological trend.
      .order("scanned_at", { ascending: false })
      .limit(2000),
    supabase
      .from("code_contributions")
      .select("author_key, author_name, member_id, commits, ai_commits, additions, deletions")
      .eq("codebase_id", codebaseId)
      .gte("day", windowStart.slice(0, 10))
      .limit(10_000),
    supabase
      .from("github_issues")
      .select("number, title, state, is_pull_request, author_login, labels, url, opened_at")
      .eq("codebase_id", codebaseId)
      .order("updated_at", { ascending: false })
      .limit(200),
    supabase.from("members").select("id, display_name, github_login, avatar_url").eq("team_id", teamId),
  ]);

  type MemberMeta = { display_name: string | null; github_login: string | null; avatar_url: string | null };
  const members = new Map<string, MemberMeta>();
  for (const m of (membersRes.data ?? []) as ({ id: string } & MemberMeta)[]) {
    members.set(m.id, { display_name: m.display_name, github_login: m.github_login, avatar_url: m.avatar_url });
  }

  // newest-first from the query; reverse a copy for the chronological trend.
  const metrics = (metricsRes.data ?? []) as unknown as Record<string, unknown>[];
  const chronological = [...metrics].reverse();
  const latest = metrics[0];

  const breakdown: AgenticBreakdown | null = latest
    ? {
        agentic_score: num(latest.agentic_score as number),
        health_score: num(latest.health_score as number),
        ai_commit_ratio: num(latest.ai_commit_ratio as number),
        test_coverage_score: num(latest.test_coverage_score as number),
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
          latest.test_coverage_pct == null ? null : num(latest.test_coverage_pct as number),
      }
    : null;

  const trend: TrendPoint[] = chronological.map((m) => ({
    date: new Date(m.scanned_at as string).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    agentic: num(m.agentic_score as number),
    coverage: m.test_coverage_pct == null ? null : num(m.test_coverage_pct as number),
    ai: num(m.ai_commit_ratio as number),
  }));

  // aggregate contributions per author across the window
  const contribRows = (contribRes.data ?? []) as {
    author_key: string;
    author_name: string;
    member_id: string | null;
    commits: number;
    ai_commits: number;
    additions: number;
    deletions: number;
  }[];
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
  const contributors = [...byContributor.values()].sort((a, b) => b.commits - a.commits);

  const issues = ((issuesRes.data ?? []) as IssueRow[]).map((i) => ({
    ...i,
    labels: Array.isArray(i.labels) ? i.labels : [],
  }));

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
    breakdown,
    recent_commits: Array.isArray(latest?.recent_commits)
      ? (latest.recent_commits as Record<string, unknown>[])
      : [],
    trend,
    contributors,
    issues,
  };
}
