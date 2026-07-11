import { serverClient } from "@/lib/db/server";
import { listOpportunities } from "@/lib/social/store";
import { SocialOpportunitiesPanel, type VariantView } from "@/components/admin/social-opportunities-panel";

export default async function SocialAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  // Admin view — the whole /admin area is admin-gated, so it sees all tiers (team).
  const opportunities = await listOpportunities(db, team.id, "team", 100);

  // Variants grouped by opportunity (plan is the join). Reads only; admin-gated area.
  const { data: plans } = await db.from("content_plans").select("id, opportunity_id").eq("team_id", team.id);
  const planToOpp = new Map((plans ?? []).map((p: { id: string; opportunity_id: string }) => [p.id, p.opportunity_id]));
  const { data: variants } = await db
    .from("content_variants")
    .select("id, plan_id, platform, status, body, validation")
    .eq("team_id", team.id)
    .order("created_at", { ascending: true });

  const byOpportunity: Record<string, VariantView[]> = {};
  for (const v of (variants ?? []) as (VariantView & { plan_id: string })[]) {
    const oppId = planToOpp.get(v.plan_id);
    if (oppId) (byOpportunity[oppId] ??= []).push(v);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        The <strong>Social Brain</strong> turns your team’s knowledge into content. <em>Discover</em>
        ranks recent decisions, deliverables, and commits; <em>Plan</em> shapes brand-aware variants;
        <em>Generate</em> drafts each in your voice, grounded only in the source evidence and checked
        against your governance rules. Each opportunity inherits the tier of its source, so
        internal-only knowledge can never surface in a public post.
      </p>
      <SocialOpportunitiesPanel
        teamSlug={teamSlug}
        opportunities={opportunities}
        variantsByOpportunity={byOpportunity}
      />
    </div>
  );
}
