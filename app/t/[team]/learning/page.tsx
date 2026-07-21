import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { resolveTeamContext } from "@/lib/auth/team-context";
import { FactsFeed } from "@/components/learning/facts-feed";
import { EventsFeed } from "@/components/learning/events-feed";
import { ArcsPanel } from "@/components/learning/arcs-panel";

export const metadata: Metadata = { title: "Learning" };

/**
 * "What the Brain is Learning" — narrative arcs (Layer 3) are the payoff and stay expanded; events
 * and atomic facts (Layers 1–2) are the raw evidence trail underneath, collapsed by default behind a
 * single disclosure — nobody wants to scroll past 15 raw facts to reach the arcs that are the actual
 * reason they opened the page (see docs/design/brain-learning-panel.md). Facts are tier-scoped in the
 * API (`visibleGroupIds`), so an `external` viewer only ever sees external-tier facts.
 */
export default async function LearningPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  // Shared request-scoped auth — reuses the team layout's resolution (no extra team/member queries).
  const ctx = await resolveTeamContext(teamSlug);
  if (!ctx) return null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">What the brain is learning</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Live facts the brain is extracting from your team&apos;s activity — the atoms that build
          into events and narrative arcs.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Narrative arcs · most recent
        </h2>
        <ArcsPanel teamSlug={teamSlug} />
      </section>

      <details className="group/activity rounded-lg border border-border-subtle px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/activity:rotate-90" />
          Recent activity — events &amp; atomic facts
        </summary>

        <div className="mt-4 flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
              Events · last 7 days
            </h3>
            <EventsFeed teamSlug={teamSlug} />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
              Atomic facts · last 24h
            </h3>
            <FactsFeed teamSlug={teamSlug} />
          </section>
        </div>
      </details>
    </div>
  );
}
