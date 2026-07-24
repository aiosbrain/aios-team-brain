import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { Rocket, ChevronRight, Loader2 } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { visibleItems, visibleDecisions } from "@/lib/auth/visibility";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { PipelineHealthBanner } from "@/components/admin/pipeline-health-banner";
import { CopySnippet } from "@/components/copy-snippet";
import { getPulseMetrics } from "@/lib/metrics/pulse";
import { parseRange } from "@/lib/metrics/range";
import { pickHomeState } from "@/lib/dashboard/home-state";
import { buildAgentOnboardingPrompt } from "@/lib/onboarding/agent-prompt";
import { AskBar } from "@/components/dashboard/ask-bar";
import { KpiBand } from "@/components/dashboard/kpi-band";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { DecisionsCard } from "@/components/dashboard/decisions-card";
import { WorkingOn } from "@/components/dashboard/working-on";
import { WorkstationSetup } from "@/components/dashboard/workstation-setup";
import { ArcsPanel } from "@/components/learning/arcs-panel";
import { TimelinePanel } from "@/components/learning/timeline-panel";
import { EventsFeed } from "@/components/learning/events-feed";
import { FactsFeed } from "@/components/learning/facts-feed";
import type { MyKeyRow } from "@/components/people/my-api-keys";
import type { DecisionRow } from "@/components/dashboard/types";
import { KnowledgeGrowth } from "@/components/charts/knowledge-growth";
import { UsageChart } from "@/components/charts/usage-chart";
import { TaskFunnel } from "@/components/charts/task-funnel";

/**
 * The team's "Pulse" — the landing surface leads with the brain's SYNTHESIZED understanding: the
 * narrative arcs (what's happening) and per-person "working on" (who's doing what), both read from the
 * shared context layers. Query is a slim entry point, and the operational metrics + raw evidence trail
 * (absorbed from the old Learning tab) live below in collapsed disclosures — present for those who want
 * them, subordinate to the story. See docs/design/pulse-home.md.
 */

export const metadata: Metadata = { title: "Pulse" };

/** A collapsed section that defers its heavy/secondary content behind a disclosure. */
function Section({ title, subtitle, defaultOpen = false, children }: { title: string; subtitle?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="group/sec rounded-lg border border-border-subtle px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/sec:rotate-90" />
        {title}
        {subtitle ? <span className="font-normal normal-case tracking-normal text-ink-tertiary/70">· {subtitle}</span> : null}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

/** A labelled heading for the top (always-visible) narrative bands. */
function BandHeading({ title }: { title: string }) {
  return <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">{title}</h2>;
}

function SetupChecklist({ teamSlug }: { teamSlug: string }) {
  const steps = [
    <span key="1">
      Invite your team in{" "}
      <Link href={`/t/${teamSlug}/admin/members`} className="text-violet underline underline-offset-2">
        Admin → Members
      </Link>
    </span>,
    <span key="2">
      Each teammate generates their own API key from their profile page once signed in (or an admin can issue one for them in{" "}
      <Link href={`/t/${teamSlug}/admin/keys`} className="text-violet underline underline-offset-2">
        Admin → Keys
      </Link>
      )
    </span>,
    <span key="3">
      Run <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-xs">aios push</code> from your project repo
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
    visibleItems(db.from("items").select("id", { count: "exact", head: true }).eq("team_id", team.id), tier),
    db.from("api_keys").select("id", { count: "exact", head: true }).eq("team_id", team.id).eq("member_id", memberId),
  ]);

  const homeState = pickHomeState({ isAdmin, itemCount: itemCount ?? 0, hasOwnKey: (ownKeyCount ?? 0) > 0 });

  if (homeState === "admin-bootstrap") {
    return (
      <div className="mx-auto max-w-3xl pt-8">
        <h1 className="mb-6 text-2xl font-semibold text-ink">Pulse</h1>
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
        <h1 className="mb-6 text-2xl font-semibold text-ink">Pulse</h1>
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

  const [pulse, { data: decisions }, pipelineHealth] = await Promise.all([
    getPulseMetrics(db, team.id, range, { isAdmin, memberId, tier }),
    visibleDecisions(
      db.from("decisions").select("id, title, decided_at, tier, still_valid, source_item_id").eq("team_id", team.id).order("decided_at", { ascending: false }).limit(8),
      tier,
    ),
    // Admins see a loud banner here (the landing page) if any ingestion leg is broken — so a wedged
    // pipeline surfaces without digging into Admin. Non-admins don't fetch it.
    isAdmin ? getPipelineHealth(team.id) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {pipelineHealth ? <PipelineHealthBanner health={pipelineHealth} href={`/t/${teamSlug}/admin/integrations`} /> : null}

      <div>
        <h1 className="text-2xl font-semibold text-ink">Pulse</h1>
        <p className="mt-1 text-sm text-ink-tertiary">What your team is working on, and what the brain is learning.</p>
      </div>

      <AskBar teamSlug={teamSlug} teamName={team.name} />

      {/* HERO — narrative arcs: the story of the team right now. */}
      <section className="flex flex-col gap-3">
        <BandHeading title="Narrative arcs · most recent" />
        <ArcsPanel teamSlug={teamSlug} />
      </section>

      {/* Who's doing what — reads the SAME work-timeline layer as the Timeline below (shared card), so
          they agree by construction. The consistency fix (#358) lives inside this component, which
          renders its own "Working on" heading. */}
      <WorkingOn teamSlug={teamSlug} />

      {/* Timeline — the per-day drill-down (absorbed from the old Learning tab), collapsed by default. */}
      <Section title="Timeline" subtitle="recent work, by day">
        <Suspense
          fallback={
            <p className="flex items-center gap-2 px-1 py-4 text-sm text-ink-tertiary">
              <Loader2 className="size-4 animate-spin" /> building timeline…
            </p>
          }
        >
          <TimelinePanel teamId={team.id} teamSlug={teamSlug} tier={tier} />
        </Suspense>
      </Section>

      {/* Operational metrics — subordinate to the story; open for admins, collapsed for members. The
          range selector lives here because it only drives these charts. */}
      <Section title="Metrics" subtitle="knowledge, usage, and tasks" defaultOpen={isAdmin}>
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-end">
            <RangeSelector value={range} />
          </div>
          <KpiBand kpis={pulse.kpis} teamSlug={teamSlug} />
          {/* Brain usage (queries + spend) is the primary signal, so it gets the width; knowledge
              growth is a smaller secondary visual beside it. */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <UsageChart data={pulse.usage} scope={isAdmin ? "team" : "your"} />
            </div>
            <KnowledgeGrowth data={pulse.knowledge} />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <DecisionsCard teamSlug={teamSlug} decisions={(decisions ?? []) as DecisionRow[]} />
            <TaskFunnel data={pulse.funnel} />
          </div>
        </div>
      </Section>

      {/* Evidence trail — the raw facts + events the arcs are built from (absorbed from Learning). */}
      <Section title="Evidence trail" subtitle="events & atomic facts">
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Events · last 7 days</h3>
            <EventsFeed teamSlug={teamSlug} />
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Atomic facts · last 24h</h3>
            <FactsFeed teamSlug={teamSlug} />
          </section>
        </div>
      </Section>
    </div>
  );
}
