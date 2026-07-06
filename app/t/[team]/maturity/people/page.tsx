import type { Metadata } from "next";
import Link from "next/link";
import { Gauge } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getTeamMaturity, AXIS_META, type AemAxes } from "@/lib/metrics/individual-maturity";
import { EmptyState } from "@/components/empty-state";
import { MaturityRadar, type RadarDatum } from "@/components/charts/maturity-radar";

export const metadata: Metadata = { title: "Individual Maturity" };

const SPINE_ORDER = ["L1", "L2", "L3", "L4", "L5"];
const SPINE_LABEL: Record<string, string> = {
  L1: "Prompting", L2: "Prompt Eng", L3: "Context Eng", L4: "Agentic Eng", L5: "Orchestration",
};

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(n < 1 && n > 0 ? 4 : 2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

function CeShadowBadge() {
  return (
    <span className="ml-1.5 rounded-full bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">
      shadow · uncalibrated
    </span>
  );
}

function fmtCeBand(band: number | null): string {
  return band == null ? "—" : `${band}/4`;
}

function radarData(axes: AemAxes): RadarDatum[] {
  return AXIS_META.map((a) => ({ axis: a.label, you: axes[a.key] }));
}

export default async function MaturityPage({ params }: { params: Promise<{ team: string }> }) {

  const { team: teamSlug } = await params;
  const db = await serverClient();
  const { data: team } = await db.from("teams").select("id, name").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  // Read helper enforces the team-tier gate (external → empty board).
  const { members, teamAxes, spineDistribution, asOf } = await getTeamMaturity(db, team.id, me.tier);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Individual Maturity</h1>
        <p className="text-sm text-ink-secondary">
          Per-person AEM placement from local agent sessions (Claude Code · Codex · Cursor).
          {asOf ? ` Latest snapshot ${asOf}.` : ""}
        </p>
      </div>

      {members.length === 0 ? (
        <EmptyState
          icon={Gauge}
          title="No maturity snapshots yet"
          action="Snapshots appear after a teammate runs `aios analyze --push` from their workspace. Raw sessions stay on their machine — only daily aggregate scores are pushed."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MaturityRadar
              data={radarData(teamAxes)}
              primaryLabel="Team avg"
              title="Team radar"
              hint={`average across ${members.length} member(s)`}
            />
            <div className="card flex flex-col gap-3 p-5">
              <h3 className="text-sm font-semibold text-ink">Spine distribution</h3>
              <div className="flex flex-col gap-2">
                {SPINE_ORDER.map((lvl) => {
                  const n = spineDistribution[lvl] ?? 0;
                  const pct = members.length ? Math.round((n / members.length) * 100) : 0;
                  return (
                    <div key={lvl} className="flex items-center gap-3 text-sm">
                      <span className="w-8 font-mono text-ink">{lvl}</span>
                      <span className="w-28 text-ink-secondary">{SPINE_LABEL[lvl]}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                        <div className="h-full rounded-full bg-gradient-prism" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 text-right tabular-nums text-ink-secondary">{n}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-subtle">
                  <th className="px-4 py-3 font-medium">Member</th>
                  <th className="px-4 py-3 font-medium">Spine</th>
                  <th className="px-4 py-3 font-medium">Overall</th>
                  <th className="px-4 py-3 font-medium">CE</th>
                  <th className="px-4 py-3 font-medium">Weakest axis</th>
                  <th className="px-4 py-3 text-right font-medium">Tasks</th>
                  <th className="px-4 py-3 text-right font-medium">Est. spend</th>
                  <th className="px-4 py-3 text-right font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.member_id} className="border-b border-border-subtle/50 last:border-0 hover:bg-surface-raised/50">
                    <td className="px-4 py-3">
                      <Link href={`/t/${teamSlug}/maturity/people/${m.handle}`} className="font-medium text-ink hover:text-gradient-prism">
                        {m.name}
                      </Link>
                      <span className="ml-2 text-xs text-ink-subtle">@{m.handle}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink">{m.spine}</span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-secondary">{m.overall.toFixed(2)}</td>
                    <td className="px-4 py-3 tabular-nums text-ink-secondary">
                      {fmtCeBand(m.ce_band)}
                      <CeShadowBadge />
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {AXIS_META.find((a) => a.key === m.weakest)?.label}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-secondary">{m.tasks}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-secondary" title="API-equivalent from session logs">
                      {m.total_cost_usd > 0 ? fmtUsd(m.total_cost_usd) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-secondary">
                      {m.total_tokens > 0 ? fmtTokens(m.total_tokens) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
