import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { parseRange } from "@/lib/metrics/range";
import { getPerMemberCosts, getThroughputVsCost } from "@/lib/metrics/members";
import { getExternalCosts, getCombinedSpend } from "@/lib/metrics/external-costs";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { MemberCostTable } from "@/components/usage/member-cost-table";
import { ExternalCostTable } from "@/components/usage/external-cost-table";
import { ThroughputCostTable } from "@/components/usage/throughput-cost-table";

/**
 * Admin → Usage. Brain spend (query_log) + external AI spend (usage_costs from workstations).
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

  const [costs, external, throughput] = await Promise.all([
    getPerMemberCosts(supabase, team.id, range, viewer),
    getExternalCosts(supabase, team.id, range, viewer),
    getThroughputVsCost(supabase, team.id, range, viewer),
  ]);
  const combined = await getCombinedSpend(supabase, team.id, range, viewer, external);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-secondary">
          Team AI spend — brain queries plus external providers (Cursor, Claude) pushed from
          workstations via <code className="text-xs">aios analyze --push</code>.
        </p>
        <RangeSelector value={range} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <SummaryCard label="Brain spend" value={`$${costs.totals.cost_usd.toFixed(2)}`} />
        <SummaryCard
          label="External AI"
          value={`$${external.totals.cost_usd.toFixed(2)}`}
          accent
        />
        <SummaryCard label="Combined" value={`$${combined.total_usd.toFixed(2)}`} accent />
        <SummaryCard label="Brain queries" value={costs.totals.queries.toLocaleString("en-US")} />
      </div>

      {external.by_provider.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
            External by provider
          </h2>
          <div className="flex flex-wrap gap-3">
            {external.by_provider.map((p) => (
              <div key={p.provider} className="prism-card px-4 py-3">
                <p className="text-[11px] uppercase tracking-wider text-ink-tertiary capitalize">
                  {p.provider}
                </p>
                <p className="mt-1 text-lg font-semibold text-emerald">${p.cost_usd.toFixed(2)}</p>
                <p className="text-xs text-ink-tertiary">{p.events} events</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          External AI spend
        </h2>
        <ExternalCostTable rows={external.rows} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Brain spend per member
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
