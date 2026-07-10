import "server-only";
import type { DbClient } from "@/lib/db/types";
import { rangeDays, type Range } from "./range";
import { scopeQueryLog, type QueryLogViewer } from "@/lib/auth/visibility";
import { num, round } from "@/lib/num";

/**
 * Per-member BRAIN spend (W1.2). The ONLY read path for per-member query_log cost — pages
 * must go through here. In postgres mode there is NO RLS, so member/role scoping is NOT
 * automatic; it is applied in app code via `scopeQueryLog` (CLAUDE.md §5):
 *   • admins → the whole team's rows (one row per member),
 *   • everyone else → only their own row.
 * The query-log-visibility guard fails the build if any query_log read here skips scopeQueryLog.
 *
 * Out of scope (Wave 2): external-provider spend. This is brain spend (query_log.cost_usd +
 * input/output/cache tokens) only.
 *
 * Throughput-vs-cost joins `code_contributions` (authors already resolved to member_id at
 * ingest via the SHARED lib/identity/resolve resolver — we reuse that mapping, never a second
 * copy) against this spend to surface "$ per AI commit" per contributor.
 *
 * Aggregation is done in JS over rows fetched within the window (the pulse.ts pattern).
 */

export interface MemberCostRow {
  member_id: string | null;
  member_name: string;
  avatar_url: string | null;
  avatar_data_url: string | null;
  github_login: string | null;
  queries: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface PerMemberCosts {
  rows: MemberCostRow[];
  totals: { queries: number; total_tokens: number; cost_usd: number };
  /** true when the viewer is scoped to themselves (non-admin) — pages label accordingly. */
  selfOnly: boolean;
}

type QueryLogRow = {
  member_id: string | null;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cost_usd: number | string;
  created_at: string;
};

type MemberMeta = {
  display_name: string | null;
  actor_handle: string | null;
  github_login: string | null;
  avatar_url: string | null;
  avatar_data_url: string | null;
};

const UNATTRIBUTED = "Unattributed";

/**
 * Aggregate brain spend (query_log) by member over the window. Routes the query_log read
 * through `scopeQueryLog`: admins get team-wide rows, everyone else only their own.
 */
export async function getPerMemberCosts(
  db: DbClient,
  teamId: string,
  range: Range,
  viewer: QueryLogViewer
): Promise<PerMemberCosts> {
  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString();

  const [logRes, membersRes, profilesRes] = await Promise.all([
    scopeQueryLog(
      db
        .from("query_log")
        .select("member_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, created_at")
        .eq("team_id", teamId)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: false })
        .limit(50_000),
      viewer
    ),
    db
      .from("members")
      .select("id, display_name, actor_handle, github_login, avatar_url")
      .eq("team_id", teamId),
    // Uploaded avatars live on member_profiles (1:1, separate table — the pg adapter's embeds
    // don't cover this relationship), so it's a sibling query merged in JS.
    db.from("member_profiles").select("member_id, avatar_data_url").eq("team_id", teamId),
  ]);

  const logRows = (logRes.data ?? []) as QueryLogRow[];
  const avatarDataByMember = new Map(
    ((profilesRes.data ?? []) as { member_id: string; avatar_data_url: string | null }[]).map((p) => [
      p.member_id,
      p.avatar_data_url,
    ])
  );
  const members = new Map<string, MemberMeta>();
  for (const m of (membersRes.data ?? []) as ({ id: string } & Omit<MemberMeta, "avatar_data_url">)[]) {
    members.set(m.id, {
      display_name: m.display_name,
      actor_handle: m.actor_handle,
      github_login: m.github_login,
      avatar_url: m.avatar_url,
      avatar_data_url: avatarDataByMember.get(m.id) ?? null,
    });
  }

  const byMember = new Map<string, MemberCostRow>();
  const totals = { queries: 0, total_tokens: 0, cost_usd: 0 };

  for (const r of logRows) {
    const key = r.member_id ?? UNATTRIBUTED;
    const meta = r.member_id ? members.get(r.member_id) : undefined;
    const cur =
      byMember.get(key) ??
      ({
        member_id: r.member_id,
        member_name:
          meta?.display_name ?? meta?.actor_handle ?? (r.member_id ? "Unknown" : UNATTRIBUTED),
        avatar_url: meta?.avatar_url ?? null,
        avatar_data_url: meta?.avatar_data_url ?? null,
        github_login: meta?.github_login ?? null,
        queries: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
      } as MemberCostRow);

    const inTok = num(r.input_tokens);
    const outTok = num(r.output_tokens);
    const cacheTok = num(r.cache_read_tokens);
    cur.queries += 1;
    cur.input_tokens += inTok;
    cur.output_tokens += outTok;
    cur.cache_read_tokens += cacheTok;
    cur.total_tokens += inTok + outTok + cacheTok;
    cur.cost_usd = round(cur.cost_usd + num(r.cost_usd), 5);
    byMember.set(key, cur);

    totals.queries += 1;
    totals.total_tokens += inTok + outTok + cacheTok;
    totals.cost_usd = round(totals.cost_usd + num(r.cost_usd), 5);
  }

  const rows = [...byMember.values()].sort((a, b) => b.cost_usd - a.cost_usd);
  return { rows, totals, selfOnly: !viewer.isAdmin };
}

// ── throughput vs. cost (W1.2.3) ──────────────────────────────────────────────

export interface ThroughputCostRow {
  member_id: string;
  member_name: string;
  avatar_url: string | null;
  avatar_data_url: string | null;
  ai_commits: number;
  commits: number;
  cost_usd: number;
  /** brain $ per AI-assisted commit; null when the member has no AI commits in the window. */
  cost_per_ai_commit: number | null;
  /** brain $ per commit (any); null when the member has no commits in the window. */
  cost_per_commit: number | null;
}

export interface ThroughputCost {
  rows: ThroughputCostRow[];
  selfOnly: boolean;
}

/**
 * Join code throughput (code_contributions, authors already resolved to member_id at ingest via
 * the SHARED resolver) × brain spend (query_log, scoped via scopeQueryLog) to surface
 * "$ per AI commit / per contributor". Admins see all members; everyone else only themselves.
 * Only members with at least one resolved contribution in the window appear (unmapped git
 * authors have no member_id to attribute spend to).
 */
export async function getThroughputVsCost(
  db: DbClient,
  teamId: string,
  range: Range,
  viewer: QueryLogViewer
): Promise<ThroughputCost> {
  const windowStartIso = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString();
  const windowStartDay = windowStartIso.slice(0, 10);

  // Contributions are restricted to the viewer's own member_id for non-admins (mirrors the
  // query_log scoping — a member must not see another member's throughput). Admins: team-wide.
  let contribQuery = db
    .from("code_contributions")
    .select("member_id, commits, ai_commits")
    .eq("team_id", teamId)
    .gte("day", windowStartDay)
    .not("member_id", "is", null)
    .limit(50_000);
  if (!viewer.isAdmin) contribQuery = contribQuery.eq("member_id", viewer.memberId);

  const [contribRes, costs] = await Promise.all([
    contribQuery,
    getPerMemberCosts(db, teamId, range, viewer),
  ]);

  const contribRows = (contribRes.data ?? []) as {
    member_id: string;
    commits: number;
    ai_commits: number;
  }[];

  // spend per member from the already-scoped per-member aggregate
  const spendByMember = new Map<string, MemberCostRow>();
  for (const r of costs.rows) {
    if (r.member_id) spendByMember.set(r.member_id, r);
  }

  const byMember = new Map<string, ThroughputCostRow>();
  for (const r of contribRows) {
    const spend = spendByMember.get(r.member_id);
    const cur =
      byMember.get(r.member_id) ??
      ({
        member_id: r.member_id,
        member_name: spend?.member_name ?? "Member",
        avatar_url: spend?.avatar_url ?? null,
        avatar_data_url: spend?.avatar_data_url ?? null,
        ai_commits: 0,
        commits: 0,
        cost_usd: spend?.cost_usd ?? 0,
        cost_per_ai_commit: null,
        cost_per_commit: null,
      } as ThroughputCostRow);
    cur.commits += r.commits;
    cur.ai_commits += r.ai_commits;
    byMember.set(r.member_id, cur);
  }

  // backfill member names/avatars for contributors whose meta wasn't in the spend rows
  // (e.g. a member with commits but zero brain queries in the window).
  const missing = [...byMember.values()].filter((r) => r.member_name === "Member");
  if (missing.length) {
    const missingIds = missing.map((r) => r.member_id);
    const [{ data: meta }, { data: profiles }] = await Promise.all([
      db
        .from("members")
        .select("id, display_name, actor_handle, avatar_url")
        .eq("team_id", teamId)
        .in("id", missingIds),
      db.from("member_profiles").select("member_id, avatar_data_url").in("member_id", missingIds),
    ]);
    const avatarDataByMember = new Map(
      ((profiles ?? []) as { member_id: string; avatar_data_url: string | null }[]).map((p) => [
        p.member_id,
        p.avatar_data_url,
      ])
    );
    for (const m of (meta ?? []) as {
      id: string;
      display_name: string | null;
      actor_handle: string | null;
      avatar_url: string | null;
    }[]) {
      const row = byMember.get(m.id);
      if (row) {
        row.member_name = m.display_name ?? m.actor_handle ?? "Member";
        row.avatar_url = m.avatar_url;
        row.avatar_data_url = avatarDataByMember.get(m.id) ?? null;
      }
    }
  }

  const rows = [...byMember.values()].map((r) => ({
    ...r,
    cost_per_ai_commit: r.ai_commits > 0 ? round(r.cost_usd / r.ai_commits, 4) : null,
    cost_per_commit: r.commits > 0 ? round(r.cost_usd / r.commits, 4) : null,
  }));
  rows.sort((a, b) => b.cost_usd - a.cost_usd || b.commits - a.commits);

  return { rows, selfOnly: !viewer.isAdmin };
}
