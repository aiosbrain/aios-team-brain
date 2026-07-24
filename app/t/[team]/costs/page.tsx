import Link from "next/link";
import type { Metadata } from "next";
import { ChevronLeft, Coins } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { parseRange } from "@/lib/metrics/range";
import { getLlmCostBreakdown } from "@/lib/metrics/llm-costs";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { CostBreakdownChart } from "@/components/charts/cost-breakdown";
import { HelpHint } from "@/components/help-hint";

export const metadata: Metadata = { title: "Costs" };

function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
            summaries, social content, chat titles.
            <br />
            <br />
            Each call&apos;s cost is the real charge on OpenRouter (<code>usage.cost</code>) or a list-price
            estimate on Anthropic. {isAdmin ? "You see the whole team's spend, including background jobs." : "You see only the spend you personally initiated."} Spend
            from before metering shipped isn&apos;t captured.
          </HelpHint>
        </h1>
        <p className="text-sm text-ink-tertiary">
          What&apos;s costing what across the brain&apos;s LLM usage.
          {breakdown.hasEstimates ? " Some rows are list-price estimates (Anthropic), not billed amounts." : ""}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-3xl leading-none text-ink">{usd(breakdown.total_usd)}</span>
          <span className="text-sm text-ink-tertiary">
            {scopeWord} spend · last {breakdown.days}d · {breakdown.calls.toLocaleString("en-US")} call
            {breakdown.calls === 1 ? "" : "s"}
          </span>
        </div>
        <RangeSelector value={range} />
      </div>

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
