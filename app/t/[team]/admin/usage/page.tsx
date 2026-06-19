import { serverClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { parseRange } from "@/lib/metrics/range";
import { getPerMemberCosts, getThroughputVsCost } from "@/lib/metrics/members";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { MemberCostTable } from "@/components/usage/member-cost-table";
import { ThroughputCostTable } from "@/components/usage/throughput-cost-table";

/**
 * Admin → Usage (W1.2.2). Brain spend (query_log) per member + throughput-vs-cost. Lives under
 * the admin layout, which already blocks non-admins. We STILL resolve the real role and route
 * every query_log read through scopeQueryLog (inside getPerMemberCosts/getThroughputVsCost) —
 * defense-in-depth, no RLS backstop in postgres mode (CLAUDE.md §5). External-provider spend
 * is out of scope (Wave 2).
 */
export default async function UsageAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { team: teamSlug } = await params;
  const { range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);
  const supabase = await serverClient();

  const [{ data: team }, user] = await Promise.all([
    supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle(),
    getSessionUser(),
  ]);
  if (!team) return null;

  const { data: me } = await supabase
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", user?.id ?? "")
    .eq("status", "active")
    .maybeSingle();

  const isAdmin = me?.role === "admin";
  const memberId = (me?.id as string | undefined) ?? "";
  const viewer = { isAdmin, memberId };

  const [costs, throughput] = await Promise.all([
    getPerMemberCosts(supabase, team.id, range, viewer),
    getThroughputVsCost(supabase, team.id, range, viewer),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-secondary">
          Brain spend per member — query tokens &amp; cost from the team brain. External-provider
          spend (Claude/OpenAI API keys) lands in a later wave.
        </p>
        <RangeSelector value={range} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Queries" value={costs.totals.queries.toLocaleString("en-US")} />
        <SummaryCard label="Tokens" value={costs.totals.total_tokens.toLocaleString("en-US")} />
        <SummaryCard label="Brain spend" value={`$${costs.totals.cost_usd.toFixed(2)}`} accent />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Cost per member
        </h2>
        <MemberCostTable rows={costs.rows} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Throughput vs. cost
        </h2>
        <p className="text-xs text-ink-tertiary">
          Brain spend against code throughput — what each AI-assisted commit costs in brain
          queries.
        </p>
        <ThroughputCostTable rows={throughput.rows} />
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="prism-card px-5 py-4">
      <p className="text-[11px] uppercase tracking-wider text-ink-tertiary">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accent ? "text-emerald" : "text-ink"}`}>
        {value}
      </p>
    </div>
  );
}
