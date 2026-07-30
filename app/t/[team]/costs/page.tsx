import Link from "next/link";
import type { Metadata } from "next";
import { ChevronLeft, Coins } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { parseRange } from "@/lib/metrics/range";
import { getLlmCostBreakdown, getLedgerLifetimeUsd } from "@/lib/metrics/llm-costs";
import { getProviderReportedUsage, reconcileLedger } from "@/lib/costs/provider-usage";
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

  // Cost is team-internal operational data — never shown to an external-tier collaborator.
  if (isRestrictedTier(me.tier)) {
    return (
      <div className="mx-auto max-w-3xl pt-8">
        <h1 className="mb-2 text-2xl font-semibold text-ink">Costs</h1>
        <p className="text-sm text-ink-tertiary">Team-tier membership is required to view spend.</p>
      </div>
    );
  }

  const isAdmin = me.role === "admin";
  const db = await serverClient();
  const breakdown = await getLlmCostBreakdown(db, team.id, range, { isAdmin, memberId: me.id });
  const scopeWord = isAdmin ? "Team" : "Your";

  // RECONCILIATION. The ledger is a floor, not a total: a call that times out or fails after the
  // provider already generated is billed upstream and returns no `usage` for us to read, so no amount
  // of fixing the meter closes the gap. Measured 2026-07-30 the ledger said $51.46 while OpenRouter's
  // own `/credits` said $96.67 on the same key — and the page presented the floor as the answer.
  // Admins only: it is a whole-key number, so it means nothing beside one member's scoped spend.
  const providerUsage = isAdmin ? await getProviderReportedUsage(db, team.id) : null;
  const ledgerLifetimeUsd = isAdmin && providerUsage ? await getLedgerLifetimeUsd(db, team.id) : null;
  const reconciliation =
    providerUsage && ledgerLifetimeUsd !== null
      ? reconcileLedger(providerUsage.totalUsageUsd, ledgerLifetimeUsd)
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
            reconciliation.material
              ? "border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300"
              : "border-border-subtle/60 text-ink-tertiary"
          }`}
        >
          {reconciliation.material ? (
            <>
              <strong>
                OpenRouter has billed {usd(reconciliation.providerUsd)} on this key; this ledger accounts
                for {usd(reconciliation.ledgerUsd)}.
              </strong>{" "}
              {usd(reconciliation.unattributedUsd)} (
              {Math.round(reconciliation.unattributedFraction * 100)}%) can&apos;t be attributed to a
              feature. A call that times out, or fails after the model already generated, is billed by
              the provider but returns no usage for the brain to record — so the breakdown below is a{" "}
              <strong>floor</strong>, not the total. Both figures are lifetime for this key, not the
              selected window.
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
