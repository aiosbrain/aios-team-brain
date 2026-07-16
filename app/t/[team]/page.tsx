import Link from "next/link";
import { Rocket } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { visibleItems, visibleDecisions } from "@/lib/auth/visibility";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { CopySnippet } from "@/components/copy-snippet";
import { getPulseMetrics } from "@/lib/metrics/pulse";
import { parseRange } from "@/lib/metrics/range";
import { pickHomeState } from "@/lib/dashboard/home-state";
import { buildAgentOnboardingPrompt } from "@/lib/onboarding/agent-prompt";
import { AskBrain } from "@/components/dashboard/ask-brain";
import { KpiBand } from "@/components/dashboard/kpi-band";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { DecisionsCard } from "@/components/dashboard/decisions-card";
import { WorkingOn } from "@/components/dashboard/working-on";
import { WorkstationSetup } from "@/components/dashboard/workstation-setup";
import type { MyKeyRow } from "@/components/people/my-api-keys";
import type { DecisionRow } from "@/components/dashboard/types";
import { KnowledgeGrowth } from "@/components/charts/knowledge-growth";
import { UsageChart } from "@/components/charts/usage-chart";
import { TaskFunnel } from "@/components/charts/task-funnel";

function SetupChecklist({ teamSlug }: { teamSlug: string }) {
  const steps = [
    <span key="1">
      Invite your team in{" "}
      <Link
        href={`/t/${teamSlug}/admin/members`}
        className="text-violet underline underline-offset-2"
      >
        Admin → Members
      </Link>
    </span>,
    <span key="2">
      Each teammate generates their own API key from their profile page once
      signed in (or an admin can issue one for them in{" "}
      <Link
        href={`/t/${teamSlug}/admin/keys`}
        className="text-violet underline underline-offset-2"
      >
        Admin → Keys
      </Link>
      )
    </span>,
    <span key="3">
      Run{" "}
      <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-xs">
        aios push
      </code>{" "}
      from your project repo
    </span>,
    <span key="4">
      Ask your first question in{" "}
      <Link
        href={`/t/${teamSlug}/query`}
        className="text-violet underline underline-offset-2"
      >
        Query
      </Link>
    </span>,
  ];

  return (
    <div className="bg-gradient-prism rounded-2xl p-[1px]">
      <div className="rounded-2xl bg-surface-inset px-8 py-10">
        <div className="mb-4 flex items-center gap-3">
          <Rocket className="size-6 text-violet" strokeWidth={1.5} />
          <h2 className="text-xl font-semibold text-ink">
            Get your team brain online
          </h2>
        </div>
        <p className="mb-6 text-sm text-ink-secondary">
          Nothing has been synced yet. Four steps and your team&apos;s memory
          starts compounding:
        </p>
        <ol className="mb-6 flex flex-col gap-3">
          {steps.map((step, i) => (
            <li
              key={i}
              className="flex items-start gap-3 text-sm text-ink-secondary"
            >
              <span className="bg-gradient-prism mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <CopySnippet text="export AIOS_API_KEY=aios_…_… && aios push" />
      </div>
    </div>
  );
}

export default async function TeamHome({
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

  // Shared request-scoped auth — reuses the team layout's resolution (no extra team/member queries).
  const ctx = await resolveTeamContext(teamSlug);
  if (!ctx) return null; // layout already rendered the no-team screen
  const { team, me } = ctx;
  const isAdmin = me.role === "admin";
  const tier = me.tier;
  const memberId = me.id;
  const firstName = me.displayName.trim().split(/\s+/)[0] || "there";

  // Both counts are independent — run them together. itemCount is the tier-filtered visible-items
  // count (no RLS backstop in postgres mode); ownKeyCount is whether this member has EVER issued
  // their own key (the proxy for "has their workstation setup even started").
  const [{ count: itemCount }, { count: ownKeyCount }] = await Promise.all([
    visibleItems(
      db.from("items").select("id", { count: "exact", head: true }).eq("team_id", team.id),
      tier,
    ),
    db
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("team_id", team.id)
      .eq("member_id", memberId),
  ]);

  const homeState = pickHomeState({
    isAdmin,
    itemCount: itemCount ?? 0,
    hasOwnKey: (ownKeyCount ?? 0) > 0,
  });

  if (homeState === "admin-bootstrap") {
    return (
      <div className="mx-auto max-w-3xl pt-8">
        <h1 className="mb-6 text-2xl font-semibold text-ink">Home</h1>
        <SetupChecklist teamSlug={teamSlug} />
      </div>
    );
  }

  if (homeState === "member-setup") {
    const { data: keyRows } = await db
      .from("api_keys")
      .select("id, key_id, name, created_at, last_used_at, revoked_at")
      .eq("team_id", team.id)
      .eq("member_id", memberId)
      .order("created_at", { ascending: false });

    return (
      <div className="mx-auto max-w-3xl pt-8">
        <h1 className="mb-6 text-2xl font-semibold text-ink">Home</h1>
        <WorkstationSetup
          teamSlug={teamSlug}
          firstName={firstName}
          agentPrompt={buildAgentOnboardingPrompt({
            teamSlug,
            teamName: team.name,
            brainUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
          })}
          keys={(keyRows ?? []) as MyKeyRow[]}
        />
      </div>
    );
  }

  const [pulse, { data: decisions }] = await Promise.all([
    getPulseMetrics(db, team.id, range, { isAdmin, memberId }),
    visibleDecisions(
      db
        .from("decisions")
        .select("id, title, decided_at, tier, still_valid")
        .eq("team_id", team.id)
        .order("decided_at", { ascending: false })
        .limit(8),
      tier,
    ),
  ]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink">Home</h1>
        <RangeSelector value={range} />
      </div>

      <AskBrain teamSlug={teamSlug} teamName={team.name} />

      <KpiBand kpis={pulse.kpis} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <KnowledgeGrowth data={pulse.knowledge} />
        </div>
        <UsageChart data={pulse.usage} scope={isAdmin ? "team" : "your"} />
      </div>

      {/* One consolidated per-person "Working On": summary (arcs) + open tasks + accomplished. */}
      <WorkingOn teamSlug={teamSlug} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DecisionsCard
          teamSlug={teamSlug}
          decisions={(decisions ?? []) as DecisionRow[]}
        />
        <TaskFunnel data={pulse.funnel} />
      </div>
    </div>
  );
}
