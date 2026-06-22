import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rangeDays, type Range } from "./range";
import { scopeQueryLog, type QueryLogViewer } from "@/lib/auth/visibility";
import { num, round } from "@/lib/num";

/**
 * External AI provider spend (usage_costs). Read path for Admin → Usage.
 * Team-tier data only; members see their own rows, admins see team-wide.
 */

export interface ProviderCostRow {
  provider: string;
  source: string;
  project: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  events: number;
}

export interface ExternalMemberCosts {
  member_id: string | null;
  member_name: string;
  avatar_url: string | null;
  providers: ProviderCostRow[];
  cost_usd: number;
  total_tokens: number;
  events: number;
}

export interface ExternalCostsSummary {
  rows: ExternalMemberCosts[];
  by_provider: { provider: string; cost_usd: number; events: number }[];
  totals: { cost_usd: number; total_tokens: number; events: number };
  selfOnly: boolean;
}

type UsageCostRow = {
  member_id: string;
  provider: string;
  source: string;
  project: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cost_usd: number | string;
  events: number | string;
  cost_date: string;
};

type MemberMeta = {
  display_name: string | null;
  actor_handle: string | null;
  avatar_url: string | null;
};

const UNATTRIBUTED = "Unattributed";

function scopeUsageCosts(
  query: ReturnType<SupabaseClient["from"]>,
  viewer: QueryLogViewer
) {
  if (viewer.isAdmin) return query;
  return query.eq("member_id", viewer.memberId);
}

export async function getExternalCosts(
  supabase: SupabaseClient,
  teamId: string,
  range: Range,
  viewer: QueryLogViewer
): Promise<ExternalCostsSummary> {
  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [costRes, membersRes] = await Promise.all([
    scopeUsageCosts(
      supabase
        .from("usage_costs")
        .select(
          "member_id, provider, source, project, input_tokens, output_tokens, cache_read_tokens, cost_usd, events, cost_date"
        )
        .eq("team_id", teamId)
        .gte("cost_date", windowStart)
        .order("cost_date", { ascending: false })
        .limit(50_000),
      viewer
    ),
    supabase
      .from("members")
      .select("id, display_name, actor_handle, avatar_url")
      .eq("team_id", teamId),
  ]);

  const rows = (costRes.data ?? []) as UsageCostRow[];
  const members = new Map<string, MemberMeta>();
  for (const m of (membersRes.data ?? []) as ({ id: string } & MemberMeta)[]) {
    members.set(m.id, {
      display_name: m.display_name,
      actor_handle: m.actor_handle,
      avatar_url: m.avatar_url,
    });
  }

  const byMember = new Map<string, ExternalMemberCosts>();
  const byProvider = new Map<string, { cost_usd: number; events: number }>();
  const totals = { cost_usd: 0, total_tokens: 0, events: 0 };

  for (const r of rows) {
    const key = r.member_id ?? UNATTRIBUTED;
    const meta = r.member_id ? members.get(r.member_id) : undefined;
    const cur =
      byMember.get(key) ??
      ({
        member_id: r.member_id,
        member_name:
          meta?.display_name ?? meta?.actor_handle ?? (r.member_id ? "Unknown" : UNATTRIBUTED),
        avatar_url: meta?.avatar_url ?? null,
        providers: [],
        cost_usd: 0,
        total_tokens: 0,
        events: 0,
      } satisfies ExternalMemberCosts);

    const inTok = num(r.input_tokens);
    const outTok = num(r.output_tokens);
    const cacheTok = num(r.cache_read_tokens);
    const cost = num(r.cost_usd);
    const evCount = num(r.events);
    const totalTok = inTok + outTok + cacheTok;

    cur.providers.push({
      provider: r.provider,
      source: r.source,
      project: r.project,
      input_tokens: inTok,
      output_tokens: outTok,
      cache_read_tokens: cacheTok,
      total_tokens: totalTok,
      cost_usd: round(cost, 5),
      events: evCount,
    });
    cur.cost_usd = round(cur.cost_usd + cost, 5);
    cur.total_tokens += totalTok;
    cur.events += evCount;
    byMember.set(key, cur);

    const p = byProvider.get(r.provider) ?? { cost_usd: 0, events: 0 };
    p.cost_usd = round(p.cost_usd + cost, 5);
    p.events += evCount;
    byProvider.set(r.provider, p);

    totals.cost_usd = round(totals.cost_usd + cost, 5);
    totals.total_tokens += totalTok;
    totals.events += evCount;
  }

  return {
    rows: [...byMember.values()].sort((a, b) => b.cost_usd - a.cost_usd),
    by_provider: [...byProvider.entries()]
      .map(([provider, v]) => ({ provider, ...v }))
      .sort((a, b) => b.cost_usd - a.cost_usd),
    totals,
    selfOnly: !viewer.isAdmin,
  };
}

/** Combined brain + external spend for a member-facing total. */
export async function getCombinedSpend(
  supabase: SupabaseClient,
  teamId: string,
  range: Range,
  viewer: QueryLogViewer
): Promise<{ brain_usd: number; external_usd: number; total_usd: number }> {
  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString();

  const [brainRes, external] = await Promise.all([
    scopeQueryLog(
      supabase
        .from("query_log")
        .select("cost_usd")
        .eq("team_id", teamId)
        .gte("created_at", windowStart),
      viewer
    ),
    getExternalCosts(supabase, teamId, range, viewer),
  ]);

  const brain_usd = round(
    ((brainRes.data ?? []) as { cost_usd: number | string }[]).reduce(
      (s, r) => s + num(r.cost_usd),
      0
    ),
    5
  );
  const external_usd = external.totals.cost_usd;
  return {
    brain_usd,
    external_usd,
    total_usd: round(brain_usd + external_usd, 5),
  };
}
