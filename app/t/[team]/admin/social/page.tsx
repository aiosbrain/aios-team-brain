import { serverClient } from "@/lib/db/server";
import { listOpportunities } from "@/lib/social/store";
import { SocialOpportunitiesPanel } from "@/components/admin/social-opportunities-panel";

export default async function SocialAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  // Admin view — the whole /admin area is admin-gated, so it sees all tiers (team).
  const opportunities = await listOpportunities(db, team.id, "team", 100);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        The <strong>Social Brain</strong> turns your team’s knowledge into content opportunities.
        Discovery scans recent decisions, deliverables, and commits and ranks what’s worth
        communicating — each opportunity inherits the tier of its source, so internal-only knowledge
        can never be surfaced for a public post. Scoring is a first cut; planning &amp; generation
        come next.
      </p>
      <SocialOpportunitiesPanel teamSlug={teamSlug} opportunities={opportunities} />
    </div>
  );
}
