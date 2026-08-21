import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { Rocket, ChevronRight, Loader2 } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { getLlmHealth } from "@/lib/query/llm-health";
import { PipelineHealthBanner } from "@/components/admin/pipeline-health-banner";
import { GenerationHealthBanner } from "@/components/admin/generation-health-banner";
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
function Section({ id, title, subtitle, defaultOpen = false, children }: { id?: string; title: string; subtitle?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    // `id` is the anchor target for the snapshot's "Full timeline →" — it scrolls the disclosure into
    // view (still one click to open). Deliberately not auto-opened: fragment auto-expansion of <details>
    // is not portable across browsers, so relying on it would work in Chrome and silently do nothing else.
    <details id={id} open={defaultOpen} className="group/sec scroll-mt-4 rounded-lg border border-border-subtle px-4 py-3">
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
      Give each teammate the workstation setup prompt after they sign in. It inspects first
      and offers Personal / Join / Create without changing anything.
    </span>,
    <span key="3">
      Each teammate generates their own API key, approves the exact Brain origin, and
      validates their identity with{" "}
      <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-xs">GET /api/v1/me</code>
    </span>,
    <span key="4">
      After onboarding, preview the first share with{" "}
      <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-xs">aios push --dry-run</code>,
      then ask your first question in{" "}
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
        <CopySnippet text="aios onboard --inspect --json" />
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

  // Both reads are independent — run them together. itemCount is the DELIBERATE team-total
  // scalar (see the tier-ok note below); last_used_at on an active own key proves /me or another authenticated
  // request actually succeeded. Merely issuing a key is not a completed workstation setup.
  // tier-ok: the ONLY unscoped read here is the head-count scalar below — the deliberate
  // ENFB-2 F5 existence bit (no titles/kinds/projects); every other read on this page is
  // oracle-gated in-query and pinned by the guard's TITLE_SURFACE_WIRING row for this file.
  // ENFB-2 (design round 1 F5): the HOME-STATE decision keys on the TEAM-TOTAL head count —
  // deliberately NOT visible-only. An ungranted member/admin over a nonempty restricted corpus
  // must see the normal home state ("no visible content"), never the bootstrap/onboarding
  // screen. A bare team-has-any-content scalar names no title, project, or per-kind fact.
  // Every DISPLAYED count below (KPIs, growth, funnel) is visible-only via getPulseMetrics.
  const [{ count: itemCount }, { data: ownKeyRows }] = await Promise.all([
    db.from("items").select("id", { count: "exact", head: true }).eq("team_id", team.id),
    db
      .from("api_keys")
      .select("id, key_id, name, created_at, last_used_at, revoked_at")
      .eq("team_id", team.id)
      .eq("member_id", memberId)
      .order("created_at", { ascending: false }),
  ]);
  const keys = (ownKeyRows ?? []) as MyKeyRow[];
  const hasConnectedKey = keys.some((key) => !key.revoked_at && !!key.last_used_at);
  const agentPrompt = buildAgentOnboardingPrompt({
    teamSlug,
    teamName: team.name,
    brainUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
  });

  const homeState = pickHomeState({ isAdmin, itemCount: itemCount ?? 0, hasConnectedKey });

  if (homeState === "admin-bootstrap") {
    return (
      <div className="mx-auto max-w-3xl pt-8">
        <h1 className="mb-6 text-2xl font-semibold text-ink">Pulse</h1>
        <div className="flex flex-col gap-6">
          <SetupChecklist teamSlug={teamSlug} />
          {!hasConnectedKey ? (
            <WorkstationSetup
              teamSlug={teamSlug}
              firstName={firstName}
              agentPrompt={agentPrompt}
              keys={keys}
            />
          ) : null}
        </div>
      </div>
    );
  }

  // ENFB-2 §2.2: the 8-row decisions card compiles the provenance predicate IN-QUERY — the
  // card serves 8 VISIBLE rows (a post-filter would starve it to 0-8), and the select now
  // carries `created_by` so hand-typed decisions survive (the PRET-5 H2 class). The viewer's
  // oracle set resolves once here and feeds getPulseMetrics too.
  const { visibleItemIds } = await import("@/lib/access/enforce");
  const { adminClient } = await import("@/lib/db/admin");
  const { decisionsCardWindow } = await import("@/lib/access/structured-windows");
  const vis = await visibleItemIds(adminClient(), { teamId: team.id, memberId });
  // Member-only surface (AUDITFIX-1 §2a): session-authenticated dashboard.
  const provCtx = { visibleItemIds: vis.error ? new Set<string>() : vis.ids, teamPosture: tier === "team", principal: "member" as const };
  const decisionsCardP = decisionsCardWindow(team.id, provCtx, tier === "external").then((rows) => ({ data: rows }));
  const [pulse, { data: decisions }, pipelineHealth, llmHealth] = await Promise.all([
    getPulseMetrics(db, team.id, range, { isAdmin, memberId, tier, provCtx }),
    decisionsCardP,
    // Admins see a loud banner here (the landing page) if any ingestion leg is broken — so a wedged
    // pipeline surfaces without digging into Admin. Non-admins don't fetch it.
    isAdmin ? getPipelineHealth(team.id) : Promise.resolve(null),
    // GENERATION health, separately (LLMOBS-1). `llm` used to be a leg on the pipeline banner above,
    // which says "the brain isn't getting fresh data" — false for a model failure, and it
    // double-counted every arcs failure. It now gets its own banner that can name the failing feature,
    // its model and its error. Same admin gate, same fetch-nothing-for-non-admins rule.
    isAdmin ? getLlmHealth(team.id) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {pipelineHealth ? <PipelineHealthBanner health={pipelineHealth} href={`/t/${teamSlug}/admin/integrations#ingestion-runs`} /> : null}
      {llmHealth ? <GenerationHealthBanner health={llmHealth} href={`/t/${teamSlug}/admin/integrations`} /> : null}

      <div>
        <h1 className="text-2xl font-semibold text-ink">Pulse</h1>
        <p className="mt-1 text-sm text-ink-tertiary">What your team is working on, and what the brain is learning.</p>
      </div>

      {homeState === "member-setup" ? (
        <WorkstationSetup
          teamSlug={teamSlug}
          firstName={firstName}
          agentPrompt={agentPrompt}
          keys={keys}
        />
      ) : null}

      <AskBar teamSlug={teamSlug} teamName={team.name} />

      {/* ── SNAPSHOT ─────────────────────────────────────────────────────────────────────────────────
          The bounded "one screen" answer to *what's happening right now*. Every band here is capped, so
          the header's height is CONSTANT regardless of how many arcs/people exist — the property that
          separates a dashboard from the feed this page used to be. Everything below is a disclosure. */}

      {/* The three numbers, promoted out of the Metrics disclosure. The range selector comes with them
          because it's what scopes them; the charts it also drives stay collapsed below. */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <BandHeading title="At a glance" />
          <RangeSelector value={range} />
        </div>
        <KpiBand kpis={pulse.kpis} teamSlug={teamSlug} />
      </section>

      {/* Story beside people, not above them — the single column was leaving ~half the width empty while
          pushing "who's on what" a full screen down. */}
      {/* 60/40, and `items-start` so the roster sizes to its content — stretching it to match a taller
          arcs column produced a card that was mostly void while its text was being clipped. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-5">
        <section className="flex flex-col gap-3 lg:col-span-3">
          <BandHeading title="What's happening" />
          <ArcsPanel teamSlug={teamSlug} variant="digest" />
        </section>

        {/* Who's doing what — reads the SAME work-timeline layer as the Timeline below (shared card), so
            they agree by construction. The consistency fix (#358) lives inside this component, which
            renders its own "Working on" heading. */}
        <div className="lg:col-span-2">
          <WorkingOn teamSlug={teamSlug} variant="roster" timelineHref="#timeline" />
        </div>
      </div>

      {/* Timeline — the per-day drill-down (absorbed from the old Learning tab), collapsed by default. */}
      <Section id="timeline" title="Timeline" subtitle="recent work, by day">
        <Suspense
          fallback={
            <p className="flex items-center gap-2 px-1 py-4 text-sm text-ink-tertiary">
              <Loader2 className="size-4 animate-spin" /> building timeline…
            </p>
          }
        >
          <TimelinePanel teamId={team.id} teamSlug={teamSlug} tier={tier} memberId={memberId} />
        </Suspense>
      </Section>

      {/* Operational charts — subordinate to the story, and now collapsed for EVERYONE. The headline
          numbers were promoted to the "At a glance" ribbon (with the range selector that scopes them);
          what's left is ~700px of charts, which is drill-down, not snapshot. Opening it by default for
          admins was pushing the fold down for exactly the people who look at this page most. */}
      <Section title="Metrics" subtitle="knowledge, usage, and tasks">
        <div className="flex flex-col gap-6">
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
