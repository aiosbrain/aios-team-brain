import "server-only";
import type { DbClient } from "@/lib/db/types";
import { type QueryLogViewer } from "@/lib/auth/visibility";
import { num, round } from "@/lib/num";

/**
 * Flat AI-tool subscriptions (real recurring spend). Read path for Admin → Usage.
 * Team-tier data only; members see their own rows, admins see team-wide — same
 * app-code scoping as usage_costs (no RLS backstop, CLAUDE.md §5).
 */

export interface SubscriptionRow {
  member_id: string | null;
  member_name: string;
  provider: string;
  plan: string;
  monthly_usd: number;
  source: string;
}

export interface SubscriptionsSummary {
  rows: SubscriptionRow[];
  monthly_usd: number; // sum of flat subscriptions in scope
  selfOnly: boolean;
}

function scopeSubs<Q>(query: Q, viewer: QueryLogViewer): Q {
  if (viewer.isAdmin) return query;
  return (query as { eq(column: string, value: string): Q }).eq(
    "member_id",
    viewer.memberId,
  );
}

export async function getSubscriptions(
  db: DbClient,
  teamId: string,
  viewer: QueryLogViewer,
): Promise<SubscriptionsSummary> {
  const [subRes, membersRes] = await Promise.all([
    scopeSubs(
      db
        .from("subscriptions")
        .select("member_id, provider, plan, monthly_usd, source")
        .eq("team_id", teamId)
        .order("monthly_usd", { ascending: false })
        .limit(5_000),
      viewer,
    ),
    db
      .from("members")
      .select("id, display_name, actor_handle")
      .eq("team_id", teamId),
  ]);

  type SubDbRow = {
    member_id: string | null;
    provider: string;
    plan: string;
    monthly_usd: number | string;
    source: string;
  };
  const names = new Map<string, string>();
  for (const m of (membersRes.data ?? []) as {
    id: string;
    display_name: string | null;
    actor_handle: string | null;
  }[]) {
    names.set(m.id, m.display_name ?? m.actor_handle ?? "Unknown");
  }

  let total = 0;
  const rows: SubscriptionRow[] = ((subRes.data ?? []) as SubDbRow[]).map(
    (r) => {
      const monthly = num(r.monthly_usd);
      total = round(total + monthly, 2);
      return {
        member_id: r.member_id,
        member_name: r.member_id
          ? (names.get(r.member_id) ?? "Unknown")
          : "Unattributed",
        provider: r.provider,
        plan: r.plan,
        monthly_usd: round(monthly, 2),
        source: r.source,
      };
    },
  );

  return { rows, monthly_usd: total, selfOnly: !viewer.isAdmin };
}
