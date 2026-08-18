import Link from "next/link";
import type { Metadata } from "next";
import { ChevronLeft, Coins } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { parseRange } from "@/lib/metrics/range";
import { getLlmCostBreakdown, getLedgerLifetimeUsd, getLedgerMonthUsd } from "@/lib/metrics/llm-costs";
import { getGraphEfficiency, HEALTHY_CALLS_PER_EPISODE } from "@/lib/metrics/graph-efficiency";
import {
  getProviderReportedUsage,
  reconcileLedger,
  MATERIAL_ABSOLUTE_MONTH_USD,
} from "@/lib/costs/provider-usage";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { CostBreakdownChart } from "@/components/charts/cost-breakdown";
import { HelpHint } from "@/components/help-hint";

export const metadata: Metadata = { title: "Costs" };

function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const fmtDay = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Costs breakdown — the drill-down from the Pulse Spend KPI. "What is actually costing what": the
 * brain's own LLM inference spend (from `llm_usage`), sliced by feature (source), model, and provider.
 * Role-scoped: admins see the whole team's spend (incl. system/background); everyone else sees only
 * the spend they personally initiated. External-tier principals can't see it at all.
 */
export default async function CostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { team: teamSlug } = await params;
  const { range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);

  const ctx = await resolveTeamContext(teamSlug);
  if (!ctx) return null;
  const { team, me } = ctx;

  // PRET-4 §1d (money → ROLE, ruling 3): the tier gate that stood here is gone. The page's
  // existing role scoping is the whole gate — an admin sees team-wide spend; a member
  // (including an external collaborator with the member role) sees exactly their own usage
  // via scopeLlmUsage, never the company bill.
  const isAdmin = me.role === "admin";
  const db = await serverClient();
  const breakdown = await getLlmCostBreakdown(db, team.id, range, { isAdmin, memberId: me.id });
  const scopeWord = isAdmin ? "Team" : "Your";

  // RECONCILIATION. The ledger is a floor, not a total: a call that times out or fails after the
  // provider already generated is billed upstream and returns no `usage` for us to read, so no amount
  // of fixing the meter closes the gap. Measured 2026-07-30 the ledger said $51.46 while OpenRouter
  // said $96.67 — and the page presented the floor as the answer.
  // Admins only: it is a whole-key number, so it means nothing beside one member's scoped spend.
  //
  // TWO PERIODS, and the MONTH is the headline (AIO-805). The lifetime gap is dominated by a frozen
  // pre-metering block that no future work can recover, so it can never improve and cannot answer
  // "is spend escaping the meter now" — the only question worth an operator's attention. The month
  // can: it read 0.9% the morning it shipped, against 22% lifetime, on the same key.
  // WORK PER EPISODE. Graph extraction is ~99% of the bill, and its cost per CALL is the number that
  // hides a bad model: on 2026-07-30 a swap to a model 10x cheaper per call sent calls/episode from
  // ~19 to ~49 over three days while total spend FELL, because episode volume dropped faster than the
  // ratio climbed. Every headline number moved the right way while the economics moved the wrong way.
  // System-initiated work, so admin-only like the reconciliation below.
  const graphEfficiency = await getGraphEfficiency(db, team.id, range, { isAdmin, memberId: me.id });
  const providerUsage = isAdmin ? await getProviderReportedUsage(db, team.id) : null;
  const ledgerLifetimeUsd =
    isAdmin && providerUsage ? await getLedgerLifetimeUsd(db, team.id, providerUsage.provider) : null;
  const reconciliation =
    providerUsage && ledgerLifetimeUsd !== null
      ? reconcileLedger(providerUsage.totalUsageUsd, ledgerLifetimeUsd)
      : null;
  // Both month legs truncate in UTC. That the provider's month is UTC-calendar is INFERRED (its
  // usage_monthly matched an August-only ledger sum where a rolling 30 days would not) — hence the
  // copy says "the provider's calendar month" rather than claiming their boundary is ours.
  const ledgerMonthUsd =
    isAdmin && providerUsage?.monthUsageUsd != null
      ? await getLedgerMonthUsd(db, team.id, providerUsage.provider)
      : null;
  // A RAISED absolute floor for the month: its denominator resets monthly, so the lifetime-tuned $1
  // would flag ordinary skew as "spend escaping the meter today" on day one of every month.
  const monthReconciliation =
    providerUsage?.monthUsageUsd != null && ledgerMonthUsd !== null
      ? reconcileLedger(providerUsage.monthUsageUsd, ledgerMonthUsd, MATERIAL_ABSOLUTE_MONTH_USD)
      : null;

  // Show the "tracking since" caption only when metering began INSIDE the selected window — i.e. the
  // window is wider than the data, so "last 30d" overstates coverage (decided server-side to avoid a
  // `Date.now` call during render). Once the ledger predates the window the caption would just be noise.
  const trackingCaption =
    breakdown.partialWindow && breakdown.trackingSince ? fmtDay(breakdown.trackingSince) : null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={`/t/${teamSlug}`}
          className="inline-flex w-fit items-center gap-1 text-xs text-ink-tertiary transition-colors hover:text-violet"
        >
          <ChevronLeft className="size-3.5" /> Back to Pulse
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ink">
          <Coins className="size-5 text-emerald" strokeWidth={1.5} /> Costs
          <HelpHint label="How costs are computed" align="left">
            The brain&apos;s own LLM inference spend, recorded per call in the <code>llm_usage</code> ledger —
            every generation the product makes: Q&amp;A, meeting extraction, narrative arcs, timeline
            summaries, social content, chat titles, <strong>graph extraction</strong> (the Graphiti
            entity/fact pass — usually the largest), and <strong>embeddings</strong> (item indexing +
            query/graph vectors).
            <br />
            <br />
            Each call&apos;s cost is the real charge on OpenRouter (<code>usage.cost</code>), a list-price
            estimate on Anthropic or OpenAI embeddings, or $0 for a self-hosted endpoint.{" "}
            {isAdmin ? "You see the whole team's spend, including background jobs." : "You see only the spend you personally initiated."} Spend
            from before metering shipped isn&apos;t captured.
          </HelpHint>
        </h1>
        <p className="text-sm text-ink-tertiary">
          What&apos;s costing what across the brain&apos;s LLM usage.
          {breakdown.hasEstimates ? " Some rows are list-price estimates (Anthropic), not billed amounts." : ""}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-3xl leading-none text-ink">{usd(breakdown.total_usd)}</span>
            <span className="text-sm text-ink-tertiary">
              {scopeWord} spend · last {breakdown.days}d · {breakdown.calls.toLocaleString("en-US")} call
              {breakdown.calls === 1 ? "" : "s"}
              {breakdown.failed_attempts > 0 ? (
                /* Amber, never merged into the call count: these attempts were billed but carry no
                   usage to price, so they belong to the unattributed remainder above — not to the
                   figures beside them. */
                <span className="ml-1 text-amber-700">
                  · {breakdown.failed_truncated ? "≥" : ""}
                  {breakdown.failed_attempts.toLocaleString("en-US")} failed attempt
                  {breakdown.failed_attempts === 1 ? "" : "s"}
                </span>
              ) : null}
            </span>
          </div>
          {trackingCaption ? (
            <span className="text-xs text-ink-tertiary/80">
              Cost metering began {trackingCaption} — spend before then isn&apos;t captured, so this window
              shows fewer than {breakdown.days} full days.
            </span>
          ) : null}
        </div>
        <RangeSelector value={range} />
      </div>

      {/* Shown whenever we can ask the provider — not only when it looks bad. A reconciliation that
          appears only on failure teaches nobody what the number means, and its absence would be
          indistinguishable from "we didn't check". Amber only when the gap is material. */}
      {reconciliation ? (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            reconciliation.status === "unattributed"
              ? "border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300"
              : "border-border-subtle/60 text-ink-tertiary"
          }`}
        >
          {reconciliation.status === "unattributed" ? (
            <>
              <strong>
                OpenRouter has billed {usd(reconciliation.providerUsd)} on this key; this ledger accounts
                for {usd(reconciliation.ledgerUsd)}.
              </strong>{" "}
              {usd(reconciliation.unattributedUsd)} (
              {Math.round(reconciliation.unattributedFraction * 100)}%) can&apos;t be attributed to a
              feature, so the breakdown below is a <strong>floor</strong>, not the total. Three things
              land here:
              <ul className="mt-1.5 list-disc space-y-1 pl-5">
                <li>
                  <strong>Spend from before metering existed.</strong> Anything the provider billed before
                  this ledger&apos;s first metered call
                  {/* The ledger's earliest row across ALL providers, while the comparison above is scoped
                      to this one — so on a team whose first metered calls were another provider's, this
                      date is earlier than OpenRouter coverage actually began. Phrased as "the ledger's
                      first call" rather than "coverage of this key started here", which stays true either
                      way; tightening it would cost a provider-scoped query for a one-word gain. */}
                  {breakdown.trackingSince ? ` (${fmtDay(breakdown.trackingSince)})` : ""} is in its
                  lifetime total and can never enter ours.
                </li>
                <li>
                  <strong>Calls billed after the model generated but returning no usage</strong> — a
                  timeout, a dropped connection. Nothing to price, so nothing to record. Where we
                  instrument them, these are <em>counted per feature</em> as failed attempts below.
                </li>
                <li>
                  <strong>Any spend on this key from outside this instance.</strong> (Spend on your
                  account&apos;s <em>other</em> keys is no longer counted here — the provider figure is
                  scoped to the key this brain uses.)
                </li>
              </ul>
              Because the first can never be recovered, <strong>the lifetime gap has a floor</strong> —
              nothing ever clears the amount, so it cannot tell you whether spend is escaping the meter
              now.{" "}
              What matters is whether the <strong>dollars grow</strong>. Both figures are lifetime for
              this key, not the selected window.
            </>
          ) : reconciliation.status === "ledger-exceeds" ? (
            <>
              This ledger records {usd(reconciliation.ledgerUsd)} of OpenRouter spend, more than the{" "}
              {usd(reconciliation.providerUsd)} the provider reports for the current key — usually because
              the key was rotated, so older spend has no counterpart on the new one. Nothing is missing
              from the breakdown below.
            </>
          ) : (
            <>
              Reconciled against the provider: OpenRouter reports {usd(reconciliation.providerUsd)} spent
              on this key, and this ledger accounts for {usd(reconciliation.ledgerUsd)} of it (lifetime,
              not the selected window).
            </>
          )}
        </div>
      ) : null}

      {/* THE MONTH — rendered independently of the lifetime state above, deliberately. It was first
          nested inside the lifetime `unattributed` branch, which hid it whenever lifetime read
          `reconciled` (dilution) or `ledger-exceeds` (a rotated key) — i.e. it disappeared in exactly
          the situations an operator would be watching for live leakage. A headline that only renders
          as a footnote of another alarm is not a headline. */}
      {monthReconciliation ? (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            monthReconciliation.status === "unattributed"
              ? "border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300"
              : "border-border-subtle/60 text-ink-tertiary"
          }`}
        >
          {monthReconciliation.status === "unattributed" ? (
            <>
              <strong>
                This provider month, OpenRouter has billed {usd(monthReconciliation.providerUsd)} on this
                key and this ledger accounts for {usd(monthReconciliation.ledgerUsd)} —{" "}
                {usd(monthReconciliation.unattributedUsd)} unexplained.
              </strong>{" "}
              Unlike the lifetime figure, this one has no permanent floor, so{" "}
              <strong>a month gap that grows is the real signal</strong> — that is spend escaping the
              meter now, not history. The month is the provider&apos;s calendar month, not the selected
              window.
            </>
          ) : monthReconciliation.status === "ledger-exceeds" ? (
            <>
              This ledger records {usd(monthReconciliation.ledgerUsd)} this month against the{" "}
              {usd(monthReconciliation.providerUsd)} the provider reports — most likely a month-boundary
              skew, since the provider&apos;s calendar month and this ledger&apos;s UTC month can roll at
              different instants. It settles once both sides are inside the same month; nothing is
              missing from the breakdown below.
            </>
          ) : (
            <>
              <strong>
                This provider month: {usd(monthReconciliation.providerUsd)} billed on this key,{" "}
                {usd(monthReconciliation.ledgerUsd)} accounted for.
              </strong>{" "}
              A near-zero gap on the current month means the meter is capturing spend as it happens — the
              lifetime figure above is history that no metering fix can recover. The month is the
              provider&apos;s calendar month, not the selected window.
            </>
          )}
        </div>
      ) : null}

      {graphEfficiency.callsPerEpisode !== null ? (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            graphEfficiency.degrading
              ? "border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300"
              : "border-border-subtle/60 text-ink-tertiary"
          }`}
        >
          <strong>Graph extraction: {graphEfficiency.callsPerEpisode.toFixed(1)} LLM calls per episode</strong>
          {graphEfficiency.costPerEpisode !== null ? ` · ${usd(graphEfficiency.costPerEpisode)} per episode` : ""}
          {graphEfficiency.degrading ? (
            <>
              {" "}
              — and <strong>rising</strong>. Work per episode that grows with the graph usually means the
              extraction model is failing to deduplicate: each new episode is resolved against a larger
              node set, so the cost compounds. Check the <strong>Extraction model</strong> in Admin →
              Integrations.
            </>
          ) : (
            <> — healthy is under {HEALTHY_CALLS_PER_EPISODE} (extract + dedupe over nodes and edges).</>
          )}{" "}
          This is the ratio to watch, not cost per call: a model can be cheaper per call and dearer per
          episode, and total spend hides it whenever episode volume moves at the same time.
        </div>
      ) : null}

      <CostBreakdownChart
        title="By feature"
        hint="cost by source"
        data={breakdown.by_source}
        empty={breakdown.by_source.length === 0}
        help={
          <>
            Which part of the brain spent the money — the <code>source</code> tag on each metered call.
            Q&amp;A is the interactive Query box; the rest are background/automatic (arcs, meetings,
            timeline, social, chat titles).
            <br />
            <br />
            <strong>Failed attempts</strong> are calls the provider billed but that returned nothing to
            price — our own timeout fired mid-generation, the connection dropped, or the response carried
            no <code>usage</code>. Their dollars are inside the unattributed remainder above, never in
            these bars, because an aborted call reports no cost. Counted per <em>attempt</em>: the SDKs
            above us retry, and each retry is billed on its own. Instrumented on the graph proxy and the
            shared completion primitive — <strong>not</strong> on streaming Q&amp;A, chat titles, or
            app-side embeddings, so a zero here is not proof of no failures on those three.
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CostBreakdownChart
          title="By model"
          hint="cost by model"
          data={breakdown.by_model}
          empty={breakdown.by_model.length === 0}
        />
        <CostBreakdownChart
          title="By provider"
          hint="cost by provider"
          data={breakdown.by_provider}
          empty={breakdown.by_provider.length === 0}
        />
      </div>
    </div>
  );
}
