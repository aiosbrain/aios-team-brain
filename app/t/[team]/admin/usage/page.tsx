import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { parseRange } from "@/lib/metrics/range";
import { getPerMemberCosts, getThroughputVsCost } from "@/lib/metrics/members";
import {
  getExternalCosts,
  getExternalCostSeries,
} from "@/lib/metrics/external-costs";
import { getSubscriptions } from "@/lib/metrics/subscriptions";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { MemberCostTable } from "@/components/usage/member-cost-table";
import { ExternalCostTable } from "@/components/usage/external-cost-table";
import { ThroughputCostTable } from "@/components/usage/throughput-cost-table";
import {
  SpendByProviderChart,
  TokenTrendChart,
  ProviderShareChart,
  MemberSpendChart,
} from "@/components/charts/cost-charts";

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
  const db = await serverClient();

  const [{ data: team }, user] = await Promise.all([
    db.from("teams").select("id").eq("slug", teamSlug).maybeSingle(),
    getSessionUser(),
  ]);
  if (!team) return null;

  const { data: me } = await db
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", user?.id ?? "")
    .eq("status", "active")
    .maybeSingle();

  const isAdmin = me?.role === "admin";
  const memberId = (me?.id as string | undefined) ?? "";
  const viewer = { isAdmin, memberId };

  const [costs, external, series, throughput, subs] = await Promise.all([
    getPerMemberCosts(db, team.id, range, viewer),
    getExternalCosts(db, team.id, range, viewer),
    getExternalCostSeries(db, team.id, range, viewer),
    getThroughputVsCost(db, team.id, range, viewer),
    getSubscriptions(db, team.id, viewer),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-secondary">
          Team AI spend, split by what the number means — flat{" "}
          <strong>subscriptions</strong>, real <strong>billed</strong> metered
          spend, and <strong>API-equivalent value</strong> (token estimates, not
          a bill). Pushed from workstations via{" "}
          <code className="text-xs">aios analyze --push</code>.
        </p>
        <RangeSelector value={range} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <SummaryCard
          label="Subscriptions (flat)"
          value={`$${subs.monthly_usd.toFixed(0)}/mo`}
        />
        <SummaryCard
          label="Billed (metered)"
          value={`$${external.totals.billed_usd.toFixed(2)}`}
          accent
        />
        <SummaryCard
          label="API-equivalent value"
          value={`~$${external.totals.estimated_usd.toFixed(2)}`}
          hint="token estimate, not spend"
        />
        <SummaryCard
          label="Brain spend"
          value={`$${costs.totals.cost_usd.toFixed(2)}`}
        />
      </div>

      {subs.rows.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
            Subscriptions (flat, per month)
          </h2>
          <div className="flex flex-wrap gap-3">
            {subs.rows.map((s, i) => (
              <div
                key={`${s.member_id}-${s.provider}-${i}`}
                className="prism-card px-4 py-3"
              >
                <p className="text-[11px] uppercase tracking-wider text-ink-tertiary capitalize">
                  {s.provider}
                  {s.plan ? ` · ${s.plan}` : ""}
                </p>
                <p className="mt-1 text-lg font-semibold text-ink">
                  ${s.monthly_usd.toFixed(0)}/mo
                </p>
                <p className="text-xs text-ink-tertiary">{s.member_name}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

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
                  {p.estimated ? " · est." : ""}
                </p>
                <p
                  className={`mt-1 text-lg font-semibold ${p.estimated ? "text-ink-secondary" : "text-emerald"}`}
                >
                  {p.estimated ? "~" : ""}${p.cost_usd.toFixed(2)}
                </p>
                <p className="text-xs text-ink-tertiary">
                  {p.events} events
                  {p.estimated ? " · API-equivalent value" : " · billed"}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          External AI trends
        </h2>
        <p className="text-xs text-ink-tertiary">
          Cursor is authoritative billing; Claude and Codex are token estimates;
          Opencode is per-message session cost. Estimates can diverge from a
          provider&apos;s invoice.
        </p>
        {series.truncated ? (
          <p className="text-xs text-amber">
            Showing the most recent 50,000 records — older days in this window
            are omitted from the trend charts. Narrow the range for a complete
            view.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SpendByProviderChart
            data={series.spendByDay}
            providers={series.providers}
            estimated={series.estimatedProviders}
          />
          <TokenTrendChart data={series.tokensByDay} />
          <ProviderShareChart data={external.by_provider} />
          {isAdmin ? <MemberSpendChart rows={external.rows} /> : null}
        </div>
      </section>

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
          Brain spend against code throughput — what each AI-assisted commit
          costs in brain queries.
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
  hint,
}: {
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
}) {
  return (
    <div className="prism-card px-5 py-4">
      <p className="text-[11px] uppercase tracking-wider text-ink-tertiary">
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold ${accent ? "text-emerald" : "text-ink"}`}
      >
        {value}
      </p>
      {hint ? <p className="text-[11px] text-ink-tertiary">{hint}</p> : null}
    </div>
  );
}
