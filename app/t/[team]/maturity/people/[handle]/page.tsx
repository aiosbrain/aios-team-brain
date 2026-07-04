import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getMemberMaturity, AXIS_META, type AemAxes } from "@/lib/metrics/individual-maturity";
import { MaturityRadar, type RadarDatum } from "@/components/charts/maturity-radar";
import { MaturityTimeline } from "@/components/charts/maturity-timeline";

export const metadata: Metadata = { title: "Member maturity" };

function radarData(axes: AemAxes, team: AemAxes): RadarDatum[] {
  return AXIS_META.map((a) => ({ axis: a.label, you: axes[a.key], team: team[a.key] }));
}

function CeShadowBadge() {
  return (
    <span className="mt-1 inline-flex rounded-full bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">
      shadow · uncalibrated
    </span>
  );
}

export default async function MemberMaturityPage({
  params,
}: {
  params: Promise<{ team: string; handle: string }>;
}) {

  const { team: teamSlug, handle } = await params;
  const supabase = await serverClient();
  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  // Tier-gated read; external viewers and unknown handles → 404.
  const data = await getMemberMaturity(supabase, team.id, handle, me.tier);
  if (!data) notFound();

  const { latest, timeline, teamAxes, prescription } = data;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <Link href={`/t/${teamSlug}/maturity/people`} className="inline-flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Individual Maturity
      </Link>

      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{data.name}</h1>
          <p className="text-sm text-ink-secondary">
            @{data.handle} · latest snapshot {latest.date}
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg text-ink">{latest.spine}</div>
          <div className="text-xs text-ink-subtle">overall {latest.overall.toFixed(2)}/4</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-ink-subtle">Tasks</div>
          <div className="mt-1 text-xl tabular-nums text-ink">{latest.tasks}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-ink-subtle">Sessions</div>
          <div className="mt-1 text-xl tabular-nums text-ink">{latest.sessions}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-ink-subtle">CE</div>
          <div className="mt-1 text-xl tabular-nums text-ink">
            {latest.ce_band == null ? "—" : `${latest.ce_band}/4`}
          </div>
          <CeShadowBadge />
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-ink-subtle">Est. spend</div>
          <div className="mt-1 text-xl tabular-nums text-ink">
            {latest.total_cost_usd > 0 ? `$${latest.total_cost_usd.toFixed(2)}` : "—"}
          </div>
          <p className="mt-1 text-[11px] text-ink-subtle">API-equivalent from session logs</p>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-ink-subtle">Tokens</div>
          <div className="mt-1 text-xl tabular-nums text-ink">
            {latest.total_tokens > 0 ? latest.total_tokens.toLocaleString("en-US") : "—"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MaturityRadar
          data={radarData(latest.axes, teamAxes)}
          primaryLabel={data.handle}
          showTeam
          title="Axes vs. team average"
          hint="scored 0–4"
        />
        <MaturityTimeline
          data={timeline.map((t) => ({ date: t.date, overall: t.overall, ce_band: t.ce_band }))}
        />
      </div>

      <div className="card flex flex-col gap-2 p-5">
        <h3 className="text-sm font-semibold text-ink">Next move</h3>
        <p className="text-sm text-ink-secondary">
          Weakest axis: <span className="font-medium text-ink">{AXIS_META.find((a) => a.key === latest.weakest)?.label}</span>.
        </p>
        <p className="text-sm text-ink-secondary">→ {prescription}</p>
      </div>
    </div>
  );
}
