import type { Metadata } from "next";
import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
import { FactsFeed } from "@/components/learning/facts-feed";
import { ArcsPanel } from "@/components/learning/arcs-panel";

export const metadata: Metadata = { title: "Learning" };

/**
 * "What the Brain is Learning" — Layer 1 (atomic facts) for now; Layer 2 (events) and Layer 3
 * (narrative arcs) land in later phases. Facts are tier-scoped in the API (`visibleGroupIds`), so
 * an `external` viewer only ever sees external-tier facts. See docs/design/brain-learning-panel.md.
 */
export default async function LearningPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();
  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const me = await currentMember(team.id);
  if (!me) return null;

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
          Narrative arcs · last 7 days
        </h2>
        <ArcsPanel teamSlug={teamSlug} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Atomic facts · last 24h
        </h2>
        <FactsFeed teamSlug={teamSlug} />
      </section>
    </div>
  );
}
