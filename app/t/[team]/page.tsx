import Link from "next/link";
import { Rocket } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { visibleItems, visibleDecisions } from "@/lib/auth/visibility";
import { getSessionUser } from "@/lib/auth/session";
import { CopySnippet } from "@/components/copy-snippet";
import { getPulseMetrics } from "@/lib/metrics/pulse";
import { parseRange } from "@/lib/metrics/range";
import { AskBrain } from "@/components/dashboard/ask-brain";
import { KpiBand } from "@/components/dashboard/kpi-band";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { DecisionsCard } from "@/components/dashboard/decisions-card";
import { TasksByMember } from "@/components/dashboard/tasks-by-member";
import { WorkingOn } from "@/components/dashboard/working-on";
import { getWorkingOn } from "@/lib/dashboard/working-on";
import type {
  DecisionRow,
  TaskRow,
} from "@/components/dashboard/types";
import { KnowledgeGrowth } from "@/components/charts/knowledge-growth";
import { UsageChart } from "@/components/charts/usage-chart";
import { TaskFunnel } from "@/components/charts/task-funnel";

function SetupChecklist({ teamSlug }: { teamSlug: string }) {
  const steps = [
    <span key="1">
      Invite your team in{" "}
      <Link href={`/t/${teamSlug}/admin/members`} className="text-violet underline underline-offset-2">
        Admin → Members
      </Link>
    </span>,
    <span key="2">
      Issue an API key in{" "}
      <Link href={`/t/${teamSlug}/admin/keys`} className="text-violet underline underline-offset-2">
        Admin → Keys
      </Link>
    </span>,
    <span key="3">
      Run <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-xs">aios push</code>{" "}
      from your project repo
    </span>,
    <span key="4">
      Ask your first question in{" "}
      <Link href={`/t/${teamSlug}/query`} className="text-violet underline underline-offset-2">
        Query
      </Link>
    </span>,
  ];

  return (
    <div className="bg-gradient-prism rounded-2xl p-[1px]">
      <div className="rounded-2xl bg-surface-inset px-8 py-10">
        <div className="mb-4 flex items-center gap-3">
          <Rocket className="size-6 text-violet" strokeWidth={1.5} />
          <h2 className="text-xl font-semibold text-ink">Get your team brain online</h2>
        </div>
        <p className="mb-6 text-sm text-ink-secondary">
          Nothing has been synced yet. Four steps and your team&apos;s memory starts compounding:
        </p>
        <ol className="mb-6 flex flex-col gap-3">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm text-ink-secondary">
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
  const supabase = await serverClient();

  const [{ data: team }, user] = await Promise.all([
    supabase.from("teams").select("id, name").eq("slug", teamSlug).maybeSingle(),
    getSessionUser(),
  ]);
  if (!team) return null; // layout already rendered the no-team screen

  const { data: me } = await supabase
    .from("members")
    .select("id, role, tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user?.id ?? "")
    .eq("status", "active")
    .maybeSingle();
  const isAdmin = me?.role === "admin";
  const tier = ((me?.tier as "team" | "external" | undefined) ?? "external");
  const memberId = (me?.id as string | undefined) ?? "";

  // Tier-filtered count (no RLS backstop in postgres mode).
  const { count: itemCount } = await visibleItems(
    supabase.from("items").select("id", { count: "exact", head: true }).eq("team_id", team.id),
    tier
  );

  if (!itemCount) {
    return (
      <div className="mx-auto max-w-3xl pt-8">
        <h1 className="mb-6 text-2xl font-semibold text-ink">Home</h1>
        <SetupChecklist teamSlug={teamSlug} />
      </div>
    );
  }

  const [pulse, { data: openTasks }, workingOn, { data: decisions }] =
    await Promise.all([
      getPulseMetrics(supabase, team.id, range, { isAdmin, memberId }),
      supabase
        .from("tasks")
        .select("id, title, assignee, status")
        .eq("team_id", team.id)
        .in("status", ["in_progress", "blocked", "ready"])
        .order("updated_at", { ascending: false })
        .limit(200),
      // Per-person "working on", pulled from the Learning layer (Graphiti facts), roster-keyed.
      getWorkingOn(supabase, team.id, teamSlug, tier),
      visibleDecisions(
        supabase
          .from("decisions")
          .select("id, title, decided_at, tier, still_valid")
          .eq("team_id", team.id)
          .order("decided_at", { ascending: false })
          .limit(8),
        tier
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <WorkingOn entries={workingOn} />
        <DecisionsCard teamSlug={teamSlug} decisions={(decisions ?? []) as DecisionRow[]} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TasksByMember teamSlug={teamSlug} tasks={(openTasks ?? []) as TaskRow[]} />
        </div>
        <TaskFunnel data={pulse.funnel} />
      </div>
    </div>
  );
}
