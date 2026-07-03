import type { Metadata } from "next";
import Link from "next/link";
import { Gauge } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getTeamMaturity, type ReadinessLevel } from "@/lib/metrics/maturity";
import { parseRange } from "@/lib/metrics/range";
import { EmptyState } from "@/components/empty-state";
import { RangeSelector } from "@/components/dashboard/range-selector";

export const metadata: Metadata = { title: "Agentic Maturity" };

const LEVELS: ReadinessLevel[] = ["L0", "L1", "L2", "L3", "L4", "L5"];
const LEVEL_NAME: Record<ReadinessLevel, string> = {
  L0: "Pre-functional",
  L1: "Functional",
  L2: "Structured",
  L3: "Agent-ready",
  L4: "Measured",
  L5: "Self-improving",
};

export default async function MaturityPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ range?: string }>;
}) {

  const { team: teamSlug } = await params;
  const range = parseRange((await searchParams).range);
  const supabase = await serverClient();

  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  // Tier gate lives in getTeamMaturity → getCodebaseSummaries (team-only).
  const m = await getTeamMaturity(supabase, team.id, range, me.tier);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Agentic Maturity</h1>
          <p className="text-sm text-ink-secondary">
            How agent-ready the team&apos;s codebases are, scored against the AEM rubric.
          </p>
          <Link
            href={`/t/${teamSlug}/maturity/people`}
            className="mt-1 inline-block text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            View individual maturity (per-person, from agent sessions) →
          </Link>
        </div>
        <RangeSelector value={range} />
      </div>

      {m.reposScored === 0 ? (
        <EmptyState
          icon={Gauge}
          title="No agent-readiness scores yet"
          action="Run `aios assess-codebase --push` from a workspace (or POST a scan with readiness fields to /api/v1/codebases) to populate the maturity rollup."
        />
      ) : (
        <>
          {/* Headline */}
          <div className="prism-card flex flex-wrap items-end gap-8 px-6 py-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-tertiary">
                Repos at L3+ (agent-ready)
              </p>
              <p className="mt-1 font-display text-4xl font-semibold text-gradient-prism">
                {m.pctAtL3Plus}%
              </p>
              <p className="mt-1 text-xs text-ink-secondary">
                {m.atL3Plus} of {m.reposScored} scored {m.reposScored === 1 ? "repo" : "repos"}
              </p>
            </div>
            {/* Level distribution */}
            <div className="flex flex-1 items-end gap-2">
              {LEVELS.map((lvl) => {
                const n = m.distribution[lvl];
                const max = Math.max(...LEVELS.map((l) => m.distribution[l]), 1);
                return (
                  <div key={lvl} className="flex flex-1 flex-col items-center gap-1" title={LEVEL_NAME[lvl]}>
                    <span className="text-[11px] text-ink-secondary">{n || ""}</span>
                    <div
                      className={`w-full rounded-t ${Number(lvl[1]) >= 3 ? "bg-violet/60" : "bg-white/15"}`}
                      style={{ height: `${8 + (n / max) * 56}px` }}
                    />
                    <span className="font-mono text-[10px] text-ink-tertiary">{lvl}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Worst-first list — the "what to level up next" queue */}
          <div className="prism-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-ink-tertiary">
                  <th className="px-5 py-3 font-semibold">Repo</th>
                  <th className="px-5 py-3 font-semibold">Level</th>
                  <th className="px-5 py-3 font-semibold">Checks passed</th>
                </tr>
              </thead>
              <tbody>
                {m.repos.map((r) => (
                  <tr key={r.slug} className="border-b border-border-subtle/50 last:border-0">
                    <td className="px-5 py-3 font-medium text-ink">{r.slug}</td>
                    <td className="px-5 py-3">
                      <span className="font-mono text-ink-secondary">
                        {r.level} {r.level ? `· ${LEVEL_NAME[r.level]}` : ""}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-secondary">{r.pct == null ? "—" : `${r.pct}%`}</td>
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
