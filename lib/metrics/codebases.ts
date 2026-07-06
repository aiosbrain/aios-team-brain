import "server-only";
import type { DbClient } from "@/lib/db/types";
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
  staleDays: number = STALE_DAYS
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
  seriesNewestFirst: { scanned_at: string | Date; agentic_score: number | string }[],
  windowStartIso: string,
  fallback = 12
): number[] {
  // Compare by epoch ms — the pg adapter returns `scanned_at` as a Date, not an ISO string,
  // so a lexicographic string compare would silently never match (the #134 gotcha).
  const windowStartMs = Date.parse(windowStartIso);
  const inWindow = seriesNewestFirst.filter((s) => new Date(s.scanned_at).getTime() >= windowStartMs);
  const source = inWindow.length >= 2 ? inWindow : seriesNewestFirst.slice(0, fallback);
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
  ai_commit_ratio: number | string;
  readiness_level: string | null;
  readiness_pct: number | string | null;
};

export async function getCodebaseSummaries(
  db: DbClient,
  teamId: string,
  range: Range,
  tier: ViewerTier
): Promise<CodebaseListResult> {
  if (!canSeeCodebases(tier)) return { codebases: [], kpis: [] };

  const now = Date.now();
  const windowStart = new Date(now - rangeDays(range) * 86_400_000).toISOString();

  const [cbRes, mRes] = await Promise.all([
    db
      .from("codebases")
      .select("id, slug, full_name, primary_language, stars, open_issues, last_scan_at")
      .eq("team_id", teamId)
      .order("last_scan_at", { ascending: false, nullsFirst: false }),
    // NOT windowed: we want each codebase's LAST scan for the headline even if it predates the
    // range, so a card never blanks out (it's flagged `stale` instead). The sparkline windows this
    // series in JS. DESC + limit keeps the NEWEST points (ascending+limit would drop them at scale).
    db
      .from("code_metrics")
      .select("codebase_id, scanned_at, agentic_score, health_score, test_coverage_pct, ai_commit_ratio, readiness_level, readiness_pct")
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
      test_coverage_pct: latest?.test_coverage_pct == null ? null : num(latest.test_coverage_pct),
      ai_commit_ratio: num(latest?.ai_commit_ratio),
      readiness_level: latest?.readiness_level ?? null,
      readiness_pct: latest?.readiness_pct == null ? null : num(latest.readiness_pct),
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
  tier: ViewerTier
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
  for (const m of (mData ?? []) as { codebase_id: string; head_sha: string }[]) {
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
  test_coverage_functions_pct: number | null;
  test_coverage_branches_pct: number | null;
  readiness_level: string | null;
  readiness_pct: number | null;
  readiness_pillars: Record<string, { passed: number; total: number }>;
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

export interface CommitVolumePoint {
  date: string; // YYYY-MM-DD
  ai: number;
  human: number;
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
}

export async function getCodebaseDetail(
  db: DbClient,
  teamId: string,
  slug: string,
  range: Range,
  tier: ViewerTier
): Promise<CodebaseDetail | null> {
  if (!canSeeCodebases(tier)) return null;

  const { data: cb } = await db
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
    "has_agents_md, agents_md_count, skills_count, commands_count, test_coverage_pct, " +
    "test_coverage_functions_pct, test_coverage_branches_pct, recent_commits, " +
    "readiness_level, readiness_pct, readiness_pillars";

  const [metricsRes, contribRes, issuesRes, membersRes] = await Promise.all([
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
      .select("author_key, author_name, member_id, day, commits, ai_commits, additions, deletions")
      .eq("codebase_id", codebaseId)
      .gte("day", windowStart.slice(0, 10))
      .limit(10_000),
    db
      .from("github_issues")
      .select("number, title, state, is_pull_request, author_login, labels, url, opened_at")
      .eq("codebase_id", codebaseId)
      .order("updated_at", { ascending: false })
      .limit(200),
    db.from("members").select("id, display_name, github_login, avatar_url").eq("team_id", teamId),
  ]);

  type MemberMeta = { display_name: string | null; github_login: string | null; avatar_url: string | null };
  const members = new Map<string, MemberMeta>();
  for (const m of (membersRes.data ?? []) as ({ id: string } & MemberMeta)[]) {
    members.set(m.id, { display_name: m.display_name, github_login: m.github_login, avatar_url: m.avatar_url });
  }

  // newest-first from the query. `latest` is the true last scan (unwindowed) so the breakdown
  // never blanks; the trend is windowed with a fallback to the most recent points.
  const metrics = (metricsRes.data ?? []) as unknown as Record<string, unknown>[];
  // Compare by epoch ms — scanned_at comes back as a Date via the pg adapter (#134 gotcha).
  const windowStartMs = Date.parse(windowStart);
  const inWindow = metrics.filter(
    (m) => new Date(m.scanned_at as string | Date).getTime() >= windowStartMs
  );
  const chronological = [...(inWindow.length >= 2 ? inWindow : metrics.slice(0, 12))].reverse();
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
        test_coverage_functions_pct:
          latest.test_coverage_functions_pct == null ? null : num(latest.test_coverage_functions_pct as number),
        test_coverage_branches_pct:
          latest.test_coverage_branches_pct == null ? null : num(latest.test_coverage_branches_pct as number),
        readiness_level: (latest.readiness_level as string | null) ?? null,
        readiness_pct: latest.readiness_pct == null ? null : num(latest.readiness_pct as number),
        readiness_pillars:
          (latest.readiness_pillars as Record<string, { passed: number; total: number }>) ?? {},
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
    stale: isCodebaseStale((c.last_scan_at as string) ?? null, Date.now()),
    breakdown,
    recent_commits: Array.isArray(latest?.recent_commits)
      ? (latest.recent_commits as Record<string, unknown>[])
      : [],
    trend,
    commitVolume,
    contributors,
    issues,
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
  totals: { commits: number; ai_commits: number; additions: number; deletions: number; active_days: number };
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
  tier: ViewerTier
): Promise<ContributorDetail | null> {
  if (!canSeeCodebases(tier)) return null;

  const { data: cb } = await db
    .from("codebases")
    .select("id, slug")
    .eq("team_id", teamId)
    .eq("slug", slug)
    .maybeSingle();
  if (!cb) return null;

  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString().slice(0, 10);
  let q = db
    .from("code_contributions")
    .select("author_key, author_name, member_id, day, commits, ai_commits, additions, deletions")
    .eq("codebase_id", (cb as { id: string }).id)
    .gte("day", windowStart)
    .order("day", { ascending: true })
    .limit(10_000);
  q = "memberId" in ref ? q.eq("member_id", ref.memberId) : q.eq("author_key", ref.authorKey);

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
  const totals = { commits: 0, ai_commits: 0, additions: 0, deletions: 0, active_days: 0 };
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
  const member_id = "memberId" in ref ? ref.memberId : rows.find((r) => r.member_id)?.member_id ?? null;
  if (member_id) {
    const { data: m } = await db
      .from("members")
      .select("display_name, avatar_url, github_login")
      .eq("id", member_id)
      .eq("team_id", teamId)
      .maybeSingle();
    if (m) {
      const mm = m as { display_name: string | null; avatar_url: string | null; github_login: string | null };
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
  totals: { commits: number; ai_commits: number; additions: number; deletions: number; active_days: number };
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
  tier: ViewerTier
): Promise<MemberProfile | null> {
  if (!canSeeCodebases(tier)) return null;

  const { data: members } = await db
    .from("members")
    .select("id, display_name, actor_handle, github_login, avatar_url, role, status")
    .eq("team_id", teamId);
  const lc = handle.toLowerCase();
  const member = ((members ?? []) as {
    id: string;
    display_name: string | null;
    actor_handle: string | null;
    github_login: string | null;
    avatar_url: string | null;
    role: string;
    status: string;
  }[]).find(
    (m) =>
      m.status === "active" &&
      (m.actor_handle?.toLowerCase() === lc ||
        m.github_login?.toLowerCase() === lc ||
        m.id === handle)
  );
  if (!member) return null;

  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString().slice(0, 10);
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
  const totals = { commits: 0, ai_commits: 0, additions: 0, deletions: 0, active_days: 0 };
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
